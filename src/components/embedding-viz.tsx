// Renders a caption embedding as a 64x24 colour grid (1536 cells == the
// dimension of text-embedding-3-small). Cyan = negative component, pink =
// positive; alpha scales with magnitude. Pure SVG so it's server-rendered,
// cacheable, and needs no client JS. Reads like a genetic barcode per image.

const COLS = 64;
const ROWS = 24;
const CELLS = COLS * ROWS;
// text-embedding-3-small values are ~[-0.15, +0.15]. Stretch to [-1, 1]
// so alpha meaningfully tracks signal. Clamp to guard against outliers.
const SCALE = 8;

type Props = {
  vector: number[] | null;
  className?: string;
};

export function EmbeddingViz({ vector, className }: Props) {
  if (!vector || vector.length === 0) return null;
  const cells = vector.slice(0, CELLS);

  return (
    <figure
      className={`mx-auto w-full max-w-2xl overflow-hidden rounded border border-ink-800/60 bg-ink-950 p-2 ${className ?? ''}`}
      aria-label="semantic fingerprint"
    >
      <svg
        viewBox={`0 0 ${COLS} ${ROWS}`}
        preserveAspectRatio="none"
        role="img"
        aria-hidden="true"
        className="block h-20 w-full"
        style={{ imageRendering: 'pixelated' }}
      >
        {cells.map((raw, i) => {
          const v = Math.max(-1, Math.min(1, raw * SCALE));
          const mag = Math.abs(v);
          const alpha = (0.1 + mag * 0.85).toFixed(2);
          const fill =
            v >= 0
              ? `rgba(236, 72, 153, ${alpha})` // pink-500
              : `rgba(56, 189, 248, ${alpha})`; // cyan-400
          return (
            <rect
              key={i}
              x={i % COLS}
              y={Math.floor(i / COLS)}
              width={1}
              height={1}
              fill={fill}
            />
          );
        })}
      </svg>
      <figcaption className="pt-1 text-center font-mono text-[10px] uppercase tracking-wider text-ink-500">
        semantic fingerprint
      </figcaption>
    </figure>
  );
}
