const MAX_LEN = 80;

// Pure function: text -> slug. No DB access; no collision handling.
export function slugify(text: string): string {
  if (!text) return '';
  const ascii = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, ''); // strip combining marks

  const kebab = ascii
    .toLowerCase()
    .replace(/['"`]/g, '')         // drop quotes rather than replacing with '-'
    .replace(/[^a-z0-9]+/g, '-')   // any run of non-alnum becomes a single '-'
    .replace(/^-+|-+$/g, '');      // trim leading/trailing '-'

  if (kebab.length <= MAX_LEN) return kebab;

  // Truncate at word boundary if possible.
  const truncated = kebab.slice(0, MAX_LEN);
  const lastDash = truncated.lastIndexOf('-');
  if (lastDash >= 40) return truncated.slice(0, lastDash);
  return truncated;
}
