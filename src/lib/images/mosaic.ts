import sharp from 'sharp';

// Compose a numbered contact-sheet ("captcha mosaic") from a set of crop blob
// URLs, for the character verify pass. Each cell is a letterboxed crop with a
// number badge in its top-left corner; the vision model partitions the numbers
// into same-individual groups. Pure infra (fetch + sharp); the prompt/parse live
// in src/lib/universe/characters.ts.

const TILE = 220; // px, each cell (square)
const PAD = 8; // px, gap between cells
const BG = { r: 17, g: 17, b: 20, alpha: 1 }; // matches the site's ink background

// Cap the number of cells so the mosaic (and its token cost) stays bounded. A
// candidate with more crops is sampled down to the first MAX_CELLS by caller.
export const MOSAIC_MAX_CELLS = 24;

function badgeSvg(n: number): Buffer {
  // White number on a semi-opaque black rounded chip, top-left of the tile.
  const w = n >= 10 ? 46 : 34;
  return Buffer.from(
    `<svg width="${w}" height="30" xmlns="http://www.w3.org/2000/svg">
       <rect x="0" y="0" width="${w}" height="30" rx="6" fill="black" fill-opacity="0.66"/>
       <text x="${w / 2}" y="21" font-family="monospace" font-size="20" font-weight="bold"
             fill="white" text-anchor="middle">${n}</text>
     </svg>`
  );
}

async function tile(url: string, n: number): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`mosaic: fetch cell ${n} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return sharp({
    create: { width: TILE, height: TILE, channels: 4, background: BG }
  })
    .composite([
      {
        input: await sharp(buf)
          .rotate()
          .resize({ width: TILE, height: TILE, fit: 'contain', background: BG })
          .toBuffer(),
        top: 0,
        left: 0
      },
      { input: badgeSvg(n), top: 4, left: 4 }
    ])
    .png()
    .toBuffer();
}

// Build the mosaic. `urls[i]` becomes cell `i + 1`. Returns the composed image
// plus its mime; a cell whose blob fails to fetch is dropped and the returned
// `cells` array reports which original indices survived (so the caller can map
// the model's cell numbers back to the right crops).
export async function buildMosaic(
  urls: string[]
): Promise<{ image: Buffer; mime: string; cells: number[] }> {
  const picked = urls.slice(0, MOSAIC_MAX_CELLS);
  const tiles: { buf: Buffer; origIndex: number }[] = [];
  for (let i = 0; i < picked.length; i++) {
    try {
      tiles.push({ buf: await tile(picked[i]!, tiles.length + 1), origIndex: i });
    } catch (err) {
      console.error(`mosaic: skipping cell for ${picked[i]}`, err);
    }
  }
  if (tiles.length === 0) throw new Error('mosaic: no cells could be built');

  const cols = Math.ceil(Math.sqrt(tiles.length));
  const rows = Math.ceil(tiles.length / cols);
  const width = cols * TILE + (cols + 1) * PAD;
  const height = rows * TILE + (rows + 1) * PAD;

  const composites = tiles.map((t, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return {
      input: t.buf,
      left: PAD + col * (TILE + PAD),
      top: PAD + row * (TILE + PAD)
    };
  });

  const image = await sharp({ create: { width, height, channels: 4, background: BG } })
    .composite(composites)
    .webp({ quality: 82 })
    .toBuffer();

  return { image, mime: 'image/webp', cells: tiles.map((t) => t.origIndex) };
}
