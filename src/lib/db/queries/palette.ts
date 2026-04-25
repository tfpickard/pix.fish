import { sql } from 'drizzle-orm';
import { db } from '../client';
import { hydrateImages, type ImageWithRelations } from './images';
import { images } from '../schema';

// Hex similarity in CIELAB-ish ΔE is overkill for our 5-color palettes
// where dominant colors already cluster into bands; instead this helper
// returns rows whose palette array contains a color "close enough" to
// the requested hex by RGB Euclidean distance under a small threshold.
//
// THRESHOLD chosen by eye: a 30/255 component delta means a deep navy
// matches another deep navy, but not slate; and a hot pink matches
// other hot pinks but not magenta. Tune up if results feel too wide,
// down if they're too narrow.
const RGB_THRESHOLD = 30;

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export function normalizeHex(input: string): string | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(input.trim());
  return m ? `#${m[1].toLowerCase()}` : null;
}

// Returns hydrated images whose palette array contains at least one hex
// within the RGB_THRESHOLD of the target color. Skips the embeddings
// import entirely; this is a string-array lookup, not a vector search.
export async function listImagesByPaletteHex(
  hex: string,
  opts: { limit?: number; offset?: number } = {}
): Promise<ImageWithRelations[]> {
  const target = hexToRgb(hex);
  if (!target) return [];
  const limit = Math.max(1, Math.min(200, opts.limit ?? 60));
  const offset = Math.max(0, opts.offset ?? 0);
  const [tr, tg, tb] = target;
  const t2 = RGB_THRESHOLD * RGB_THRESHOLD;

  // Postgres-side filter: unnest the palette array and compare the parsed
  // RGB to the target. Returns at most one row per image (best match) and
  // ranks by squared RGB distance. `^` would be XOR in Postgres, so each
  // squared term uses an explicit multiply.
  const rows = await db.execute<{ id: number }>(sql`
    WITH candidates AS (
      SELECT
        i.id,
        MIN(
          (
            (('x' || lpad(substr(c, 2, 2), 2, '0'))::bit(8)::int - ${tr}) *
            (('x' || lpad(substr(c, 2, 2), 2, '0'))::bit(8)::int - ${tr}) +
            (('x' || lpad(substr(c, 4, 2), 2, '0'))::bit(8)::int - ${tg}) *
            (('x' || lpad(substr(c, 4, 2), 2, '0'))::bit(8)::int - ${tg}) +
            (('x' || lpad(substr(c, 6, 2), 2, '0'))::bit(8)::int - ${tb}) *
            (('x' || lpad(substr(c, 6, 2), 2, '0'))::bit(8)::int - ${tb})
          )
        ) AS dist2
      FROM images i, unnest(i.palette) AS c
      WHERE i.palette IS NOT NULL AND c ~ '^#[0-9a-fA-F]{6}$'
      GROUP BY i.id
    )
    SELECT id FROM candidates
    WHERE dist2 <= ${t2}
    ORDER BY dist2 ASC, id DESC
    LIMIT ${limit}
    OFFSET ${offset}
  `);

  const ids = rows.rows.map((r) => Number(r.id));
  if (ids.length === 0) return [];
  // Re-fetch full image rows preserving the SQL ranking. inArray here
  // would lose order; the orderMap lookup restores it.
  const orderMap = new Map(ids.map((id, i) => [id, i] as const));
  const fetched = await db
    .select()
    .from(images)
    .where(sql`${images.id} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
  fetched.sort(
    (a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0)
  );
  return hydrateImages(fetched);
}
