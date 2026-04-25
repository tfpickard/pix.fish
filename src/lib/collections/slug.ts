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

export function mintCollectionSlug(): string {
  const n = Math.floor(1000 + Math.random() * 9000);
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${n}`;
}

// Validates an inbound slug to the same shape we mint. Used to reject
// hand-typed garbage at the API boundary so the SQL never sees an
// arbitrary user string in WHERE slug = $1 beyond what the unique
// constraint already protects.
const SLUG_RE = /^[a-z]{2,16}-[a-z]{2,16}-\d{4}$/;

export function isValidCollectionSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}
