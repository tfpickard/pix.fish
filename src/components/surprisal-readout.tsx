import { formatBits, surprisalToBits } from '@/lib/entropy-bits';

// feat/hud: per-image "distance from the center of the collection" readout for
// the detail page. Converts the stored surprisal (0..1) into a bits figure via
// src/lib/entropy-bits.ts (bits = MAX_BITS * surprisal). Renders nothing when
// the image has not been scored yet so an unscored upload shows no misleading
// zero. No layout shift -- it is plain inline flow text in the existing
// centered column.
export function SurprisalReadout({ surprisal }: { surprisal: number | null }) {
  const bits = surprisalToBits(surprisal);
  if (bits === null) return null;
  return (
    <p className="text-center font-mono text-xs text-ink-500">
      this image sits{' '}
      <span className="text-ink-300 tabular-nums">{formatBits(bits)} bits</span> from the center
      of the collection
    </p>
  );
}
