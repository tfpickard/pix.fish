// feat/hud: convert the normalized surprisal score (and the collection
// temperature) into a human-facing "bits from the center" figure for the HUD
// and the per-image readout.
//
// Why "bits": surprisal in information theory is -log2(p) bits. We do not have
// a true per-image probability, only the normalized 0..1 blend in
// images.surprisal. We map that blend onto a bounded bit scale so the number
// reads as "how many bits of surprise this image carries relative to the most
// ordinary image in the collection."
//
// Formula (documented + intentionally simple, since the underlying score is
// already a normalized blend, not a calibrated probability):
//
//   bits = MAX_BITS * surprisal
//
// where MAX_BITS is the bit-budget assigned to the most surprising image in the
// corpus (surprisal == 1). An image at the centroid with common tags scores
// surprisal ~0 -> ~0 bits ("sits at the center"); the corpus outlier scores
// surprisal ~1 -> MAX_BITS bits ("sits MAX_BITS bits from the center"). This is
// linear and stable: the same surprisal always yields the same bits, and the
// 0..1 range never escapes [0, MAX_BITS].
//
// MAX_BITS = 8 was chosen so a "very surprising" image reads as a memorable
// single-digit figure (8 bits = 1 byte of surprise) rather than an unbounded
// or fractional-feeling number. It is a presentation constant only; nothing
// downstream depends on it.
export const MAX_BITS = 8;

// Convert a stored surprisal (0..1, or null for unscored rows) into bits.
// Returns null when the image has not been scored so the UI can say so rather
// than print a misleading 0.
export function surprisalToBits(surprisal: number | null | undefined): number | null {
  if (surprisal === null || surprisal === undefined || !Number.isFinite(surprisal)) {
    return null;
  }
  const clamped = Math.max(0, Math.min(1, surprisal));
  return MAX_BITS * clamped;
}

// Format bits for display, e.g. 3.2. One decimal place keeps it precise enough
// to distinguish neighbors without implying false precision.
export function formatBits(bits: number | null): string {
  if (bits === null) return 'not yet scored';
  return bits.toFixed(1);
}
