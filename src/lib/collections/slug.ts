// Friendly slugs for shareable shelves: <adjective>-<noun>-<NNNN>.
// Picked from short, evocative pools so a slug stays under ~25 chars and
// reads as a thing the visitor might recognize. Collisions are handled
// at the call site by retrying.

const ADJECTIVES = [
  'shy',
  'quiet',
  'bright',
  'soft',
  'feral',
  'tidy',
  'gentle',
  'hollow',
  'amber',
  'velvet',
  'calm',
  'salt',
  'slow',
  'small',
  'lush',
  'dim',
  'glassy',
  'plush',
  'wry',
  'odd',
  'tame',
  'lone',
  'crisp',
  'damp',
  'noble',
  'wild',
  'pale',
  'rough',
  'sharp',
  'soaked'
];

const NOUNS = [
  'orchid',
  'shore',
  'lantern',
  'magpie',
  'attic',
  'porch',
  'haiku',
  'cipher',
  'kelp',
  'archive',
  'museum',
  'cabin',
  'depot',
  'meadow',
  'kettle',
  'tundra',
  'planet',
  'kelpie',
  'clock',
  'comet',
  'reef',
  'dune',
  'alley',
  'forge',
  'lighthouse',
  'pavilion',
  'orchestra',
  'mailroom',
  'verandah',
  'gallery'
];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// 6-hex-char random tail. With ~30 adj * 30 noun * 9000 NNNN * 16^6 hex,
// the slug pool is ~135B combinations -- enough that the URL itself is a
// usable shared secret even without separate rate-limiting. The fallback
// path appends an extra hex segment to the same base so a successful
// insert is reachable through the exact same regex below.
function randomHexSuffix(len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

export function mintCollectionSlug(): string {
  const n = Math.floor(1000 + Math.random() * 9000);
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${n}-${randomHexSuffix(6)}`;
}

// Stronger fallback used after retries collide. Doubles the hex tail so
// the inserted row is still parseable by isValidCollectionSlug -- adding
// a longer hex segment, not a new dash-separated chunk, keeps the
// 4-segment shape of the regex.
export function mintCollectionSlugFallback(): string {
  const n = Math.floor(1000 + Math.random() * 9000);
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${n}-${randomHexSuffix(12)}`;
}

// Validates an inbound slug to the same shape we mint. Used to reject
// hand-typed garbage at the API boundary so the SQL never sees an
// arbitrary user string in WHERE slug = $1 beyond what the unique
// constraint already protects. The hex tail allows 6..16 chars so the
// fallback shape (`adj-noun-NNNN-<12-hex>`) still parses.
const SLUG_RE = /^[a-z]{2,16}-[a-z]{2,16}-\d{4}-[0-9a-f]{6,16}$/;

export function isValidCollectionSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}
