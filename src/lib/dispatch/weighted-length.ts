// X's weighted character count, in its own module so both the server-side
// validator and the client-side review page can use it.
//
// It lives here rather than in caption.ts because that module reaches for the
// prompts table and the Anthropic SDK on import, which a 'use client' component
// cannot pull in. Splitting the pure function out is what lets /admin/dispatch
// report the same number validateCaption enforced, instead of a JS string length
// that understates a CJK caption by half.

// X charges 1 for code points in a handful of mostly-Latin ranges and 2 for
// everything else -- CJK, most emoji, many symbols.
const SINGLE_WEIGHT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247]
];

export function weightedLength(text: string): number {
  let total = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    total += SINGLE_WEIGHT_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi) ? 1 : 2;
  }
  return total;
}
