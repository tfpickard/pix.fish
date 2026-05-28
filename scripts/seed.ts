/**
 * Seed prompts + tag_taxonomy. Idempotent: always upserts.
 *
 * Usage:
 *   POSTGRES_URL=... bun run db:seed
 */
import { db } from '../src/lib/db/client';
import {
  aboutFields,
  aiConfig,
  constraintCards,
  galleryConfig,
  prompts,
  tagTaxonomy,
  users
} from '../src/lib/db/schema';
import { defaultAiConfig } from '../src/lib/ai/config';
import { DEFAULT_SHUFFLE_PERIOD, DEFAULT_SORT } from '../src/lib/sort/types';
import { sql } from 'drizzle-orm';

// Site admin's stable id. Drives ownership of seeded rows (about_fields,
// gallery_config) and is the row that backs public-facing /about and the
// home gallery defaults. The auth callback will upsert the same row on
// first sign-in -- this insert is just so seed-only environments work.
function ownerId(): string {
  const id = process.env.OWNER_GITHUB_ID;
  if (!id) throw new Error('OWNER_GITHUB_ID is required to seed -- it is the site admin user id');
  return id;
}

function ownerHandle(): string {
  return process.env.OWNER_HANDLE || 'admin';
}

const CAPTION_TEMPLATE = `You are generating captions for a personal image gallery.

Look at the attached image and produce exactly three short captions, each in a distinct voice:
  - variant1: LITERAL. Describe what is in the image plainly. No metaphor.
  - variant2: POETIC. Evocative, lyrical, image-forward language. Metaphor is welcome.
  - variant3: WITTY. Playful, observational, slightly dry. Not a pun or joke; a sharp noticing.

Constraints:
  - Each caption must be under 10 words.
  - Do NOT repeat the same phrasing or central noun across variants.
  - Do NOT use em dashes. Use commas, periods, or two hyphens (--) if needed.

If the owner has provided a hint caption, treat it as a reference anchor -- do not quote it, but stay in the same semantic territory.
Owner hint (may be blank): "{{existing_caption}}"

Return ONLY valid JSON in this exact shape, with no prose around it:
{
  "variant1": "<literal caption>",
  "variant2": "<poetic caption>",
  "variant3": "<witty caption>"
}`;

const DESCRIPTION_TEMPLATE = `You are generating longer descriptions for a personal image gallery.

Look at the attached image and produce exactly three descriptions, each 2 to 3 sentences, each in a distinct voice:
  - variant1: LITERAL. Plain description of subject, composition, light, colors. Journalistic.
  - variant2: POETIC. Atmosphere and mood forward. Metaphor welcome.
  - variant3: WITTY. Observational with a dry edge. Stay precise; do not make jokes.

Constraints:
  - 2 to 3 sentences per variant, full stops at the end.
  - Do NOT use em dashes. Use commas, periods, or two hyphens (--) if needed.
  - Do NOT start with "This image shows" or similar throat-clearing.

If the owner has provided a hint caption, use it as a grounding anchor.
Owner hint (may be blank): "{{existing_caption}}"

Return ONLY valid JSON in this exact shape, with no prose around it:
{
  "variant1": "<literal description>",
  "variant2": "<poetic description>",
  "variant3": "<witty description>"
}`;

const BREED_TEMPLATE = `You are inventing a new image for a personal gallery by "breeding" {{n_sources}} existing ones.

SOURCES -- the images the owner selected to breed from (their captions, descriptions, tags):
{{source_captions}}

REFERENCE NEIGHBORHOOD -- existing images that already sit closest to the average of the sources, by caption embedding. This territory is well-covered; the new image must NOT duplicate any of these:
{{neighbor_captions}}

Your job: invent ONE new image that is a spiritual successor to the sources. Share their aesthetic DNA -- mood, palette, subject family, atmosphere -- but reach for empty space within that neighborhood. The result should feel like it belongs in the same collection as the sources without being a literal combination of their subjects.

Constraints:
  - Do NOT name or reference the source images directly.
  - Do NOT use em dashes. Use commas, periods, or two hyphens (--).
  - Avoid generic stock-photo language. Be specific the way the sources are specific.

Produce three voices plus a tag set:
  - variant1: LITERAL caption. Plain-language naming of the imagined image's subject and composition. Under 12 words.
  - variant2: POETIC caption. Evocative, image-forward, metaphor allowed. Under 12 words.
  - variant3: A 2 to 3 sentence description painting the imagined scene -- subject, light, mood, palette.

Tags: 6 to 12 total, mixing taxonomy entries (from the list below, exact lower-case match) and freeform descriptors (lower-case, kebab-case if multi-word).

Taxonomy:
{{tag_taxonomy}}

Return ONLY valid JSON in this exact shape, with no prose around it:
{
  "variant1": "<literal caption>",
  "variant2": "<poetic caption>",
  "variant3": "<2-3 sentence description>",
  "tags": [
    { "tag": "photograph", "source": "taxonomy" },
    { "tag": "rain-on-asphalt", "source": "freeform" }
  ]
}`;

const DEPART_TEMPLATE = `You are inventing a new image that is a DELIBERATE DEPARTURE from {{n_sources}} existing ones.

SOURCES -- the images the owner has selected to depart from:
{{source_captions}}

REFERENCE NEIGHBORHOOD -- existing gallery images already close to the sources' centroid. The new image should also avoid living in this territory:
{{neighbor_captions}}

Your job: invent ONE new image that is, in spirit, the opposite of the sources. Flip the mood (if they're calm, be tense; if they're dark, be luminous). Flip the subject family (if they're urban, go pastoral; if they're human, go inhuman). Flip the palette. The result must be internally coherent -- not a chaotic anti-everything -- but a sincere "what if I wanted nothing this collection currently has?"

Constraints:
  - Do NOT name or reference the sources directly.
  - Do NOT use em dashes. Use commas, periods, or two hyphens (--).
  - Avoid generic stock-photo language. Be specific.

Produce three voices plus a tag set:
  - variant1: LITERAL caption. Under 12 words.
  - variant2: POETIC caption. Under 12 words.
  - variant3: A 2 to 3 sentence description painting the imagined scene.

Tags: 6 to 12 total, mixing taxonomy entries (exact lower-case match from the list) and freeform descriptors (lower-case, kebab-case).

Taxonomy:
{{tag_taxonomy}}

Return ONLY valid JSON in this exact shape:
{
  "variant1": "<literal caption>",
  "variant2": "<poetic caption>",
  "variant3": "<2-3 sentence description>",
  "tags": [
    { "tag": "photograph", "source": "taxonomy" },
    { "tag": "rain-on-asphalt", "source": "freeform" }
  ]
}`;

const ANTIBREED_TEMPLATE = `You are inventing a new image that lives in the FAR TERRITORY of {{n_sources}} existing ones, by caption embedding.

SOURCES -- images the owner selected. Their centroid is the point you should sit FAR from:
{{source_captions}}

FAR TERRITORY REFERENCES -- existing gallery images sitting farthest from the sources' centroid in embedding space. These are your nearest cousins in this anti-territory; the new image should belong to roughly this family without copying any specific one:
{{far_neighbor_captions}}

Your job: invent ONE new image that feels native to the far-territory references. It does not need to oppose the sources point-for-point; it needs to belong somewhere the sources are not. Take cues from what the far references have in common and synthesise an image in that same family.

Constraints:
  - Do NOT name or reference the sources directly.
  - Do NOT use em dashes. Use commas, periods, or two hyphens (--).
  - Avoid generic stock-photo language. Be specific.

Produce three voices plus a tag set:
  - variant1: LITERAL caption. Under 12 words.
  - variant2: POETIC caption. Under 12 words.
  - variant3: A 2 to 3 sentence description.

Tags: 6 to 12 total, mixing taxonomy entries (from the list) and freeform descriptors.

Taxonomy:
{{tag_taxonomy}}

Return ONLY valid JSON in this exact shape:
{
  "variant1": "<literal caption>",
  "variant2": "<poetic caption>",
  "variant3": "<2-3 sentence description>",
  "tags": [
    { "tag": "photograph", "source": "taxonomy" },
    { "tag": "rain-on-asphalt", "source": "freeform" }
  ]
}`;

const SUBTRACT_TEMPLATE = `You are inventing a new image by ANALOGY: take an anchor image and remove the qualities of one or more subtract images.

ANCHOR -- the image whose essence you should preserve:
{{anchor_caption}}

SUBTRACT -- the image(s) whose qualities should be REMOVED from the anchor's essence:
{{subtract_captions}}

NEIGHBOURHOOD -- existing gallery images sitting nearest to the (anchor minus subtracts) vector in embedding space. They suggest the territory you're heading toward; treat them as cousins, not models to copy:
{{neighbor_captions}}

Your job: imagine the anchor with the subtracted qualities cleanly extracted. Preserve what makes the anchor itself; remove what makes the subtract(s) themselves. If the anchor is "a portrait of a woman in a garden" and the subtract is "any portrait of a person," you might land on the garden alone. If the subtract is "any garden," you might land on the woman in a plain studio. The math is "anchor - subtract"; the result should feel like a clean residue, not a collage.

Constraints:
  - Do NOT name or reference the anchor or subtract images directly.
  - Do NOT use em dashes. Use commas, periods, or two hyphens (--).
  - Avoid generic stock-photo language. Be specific.

Produce three voices plus a tag set:
  - variant1: LITERAL caption. Under 12 words.
  - variant2: POETIC caption. Under 12 words.
  - variant3: A 2 to 3 sentence description.

Tags: 6 to 12 total, mixing taxonomy entries and freeform descriptors.

Taxonomy:
{{tag_taxonomy}}

Return ONLY valid JSON in this exact shape:
{
  "variant1": "<literal caption>",
  "variant2": "<poetic caption>",
  "variant3": "<2-3 sentence description>",
  "tags": [
    { "tag": "photograph", "source": "taxonomy" },
    { "tag": "rain-on-asphalt", "source": "freeform" }
  ]
}`;

const TAGS_TEMPLATE = `You are tagging an image for a personal gallery so it can be filtered and found later.

Produce a mix of two kinds of tags:

1) TAXONOMY tags (source: "taxonomy"). Draw from this curated list, grouped by category:
{{tag_taxonomy}}

Only use tags from the list above for source="taxonomy". Use lower-case exactly as written.

2) FREEFORM tags (source: "freeform"). Short, specific descriptors of what is actually in this image (subjects, places, objects, notable details). Lower-case, kebab-case if multi-word. No sentences.

Aim for 6 to 14 tags total with a roughly even mix of taxonomy and freeform. Include a taxonomy tag only if it actually applies. Do not invent new taxonomy tags.

Also answer one question explicitly: does the image contain nudity? Set "nsfw": true if the image shows visible human nudity (exposed genitalia, bare breasts, bare buttocks, or otherwise unclothed human bodies), and false otherwise. For this gallery, nudity is the only criterion -- violence, gore, suggestive-but-clothed imagery, drug use, and merely intense subject matter do NOT count and should be tagged false. Err on the side of true when nudity is clearly identifiable; err on the side of false when you cannot tell.

Return ONLY valid JSON in this shape, with no prose around it:
{
  "tags": [
    { "tag": "photograph",   "source": "taxonomy", "confidence": 0.95 },
    { "tag": "fire-escape",  "source": "freeform", "confidence": 0.8 }
  ],
  "nsfw": false
}`;

type Taxon = { tag: string; category: string };

// ~120 tags across 6 categories. Sort order is category-major, insertion order within.
const TAXONOMY: Taxon[] = [
  // medium (10)
  ...withCategory('medium', [
    'photograph', 'illustration', 'cartoon', 'painting', 'screenshot',
    'render', 'collage', 'sketch', 'comic', 'mixed-media'
  ]),
  // color (12)
  ...withCategory('color', [
    'color', 'black-and-white', 'monochrome', 'sepia', 'high-contrast',
    'low-contrast', 'muted', 'vibrant', 'pastel', 'neon', 'saturated', 'desaturated'
  ]),
  // style (18)
  ...withCategory('style', [
    'portrait', 'landscape', 'macro', 'aerial', 'street',
    'abstract', 'surreal', 'minimalist', 'documentary', 'candid',
    'fashion', 'still-life', 'architectural', 'fine-art', 'editorial',
    'experimental', 'cinematic', 'snapshot'
  ]),
  // mood (16)
  ...withCategory('mood', [
    'dark', 'bright', 'moody', 'playful', 'eerie',
    'calm', 'chaotic', 'nostalgic', 'melancholic', 'dreamy',
    'tense', 'serene', 'whimsical', 'ominous', 'tender', 'cold'
  ]),
  // content (34)
  ...withCategory('content', [
    'people', 'portrait-subject', 'self-portrait', 'crowd',
    'animal', 'pet', 'wildlife',
    'nature', 'flora', 'fauna', 'sky', 'water', 'mountain', 'forest',
    'urban', 'rural', 'architecture', 'interior', 'exterior',
    'food', 'drink',
    'text', 'typography', 'signage',
    'vehicle', 'transit',
    'cafe', 'restaurant', 'studio', 'bedroom', 'kitchen',
    'graffiti', 'tool', 'screen'
  ]),
  // technical (20)
  ...withCategory('technical', [
    'shallow-dof', 'deep-dof', 'long-exposure', 'short-exposure',
    'film-grain', 'digital', 'flash', 'natural-light', 'studio-lit', 'hdr',
    'silhouette', 'backlit', 'overhead', 'low-angle',
    'golden-hour', 'blue-hour', 'twilight', 'night', 'indoor', 'outdoor'
  ])
];

function withCategory(category: string, tags: string[]): Taxon[] {
  return tags.map((tag) => ({ tag, category }));
}

// Phase 5: constraint cards for the playground dice mechanic. 6 categories,
// 80+ cards. The text is the constraint itself, not a sentence about the
// constraint -- the playground UI surfaces these one at a time so each
// card has to read well on its own.
type Card = { category: string; text: string };
const CONSTRAINT_CARDS: Card[] = [
  ...withCardCategory('medium', [
    'render as Soviet socialist realism',
    'shot on a damaged Polaroid',
    'etched copperplate, 18th century',
    'paint on cardboard, gestural',
    'cyanotype on cotton paper',
    'cel-shaded animation still',
    '1980s Xerox flyer',
    'oil pastel on newsprint',
    'painted matte for a B-movie',
    'isometric pixel art, 16 colors',
    'Polaroid SX-70 with double exposure',
    'risograph, two-color overprint',
    'low-poly PlayStation 1 render'
  ]),
  ...withCardCategory('subject_archetype', [
    'a tradesman caught mid-explanation',
    'a saint disguised as a janitor',
    'a child who has just been told a secret',
    'the same dog rendered as four ages of itself',
    'a stranger you almost recognized',
    'a courier delivering something soft',
    'a teacher in their off-hours',
    'a tourist who has lost their group',
    'a fortune teller waiting for the bus',
    'two siblings who do not look alike',
    'a small animal making a decision',
    'a librarian shelving by smell',
    'a usher between screenings'
  ]),
  ...withCardCategory('modifier', [
    'subject is the wrong scale',
    'everyone is wearing the same shoes',
    'lit from below',
    'all colors are wrong by one step',
    'something is on fire in the background, nobody notices',
    'one element is too sharp; the rest is soft',
    'the floor reflects more than it should',
    'mirrors do not show what they should',
    'a hand enters frame from off-camera',
    'someone has just left the room',
    'all faces are turned three quarters away',
    'a small shadow is in the wrong place',
    'the weather inside disagrees with outside',
    'two light sources cast contradictory shadows'
  ]),
  ...withCardCategory('mood', [
    'tender menace',
    'weekday sublime',
    'post-disaster calm',
    'late-afternoon dread',
    'the moment before laughter',
    'after a small kindness',
    'minor key birthday',
    'civic loneliness',
    'rural intimacy',
    'pre-storm holiness',
    'dignified embarrassment',
    'borrowed nostalgia',
    'patient grief'
  ]),
  ...withCardCategory('idiom', [
    'National Geographic, late 1970s',
    'Wes Anderson centered still',
    'Soviet propaganda poster',
    '1990s SNES box art',
    'Le Guin paperback cover',
    'Diane Arbus, contact sheet',
    'Tarkovsky long take',
    'Bernd and Hilla Becher inventory',
    'late-period Vermeer interior',
    'Saul Leiter color slide',
    'Edward Hopper, late afternoon',
    'David Lynch motel still',
    'Studio Ghibli matte painting',
    'Italian neorealism, 1948'
  ]),
  ...withCardCategory('composition', [
    'extreme low angle',
    'subject pushed off-frame to the right',
    'horizon line halves the image',
    'foreground is in soft focus',
    'central symmetry, exact',
    'one third sky, two thirds floor',
    'rule of thirds violated deliberately',
    'subject obscured by something incidental',
    'shot through a window or doorway',
    'reflection takes up more than the subject',
    'staircase or diagonal anchors the frame',
    'negative space dominates',
    'cropped at the eyes',
    'subject is small in a vast field'
  ])
];

function withCardCategory(category: string, items: string[]): Card[] {
  return items.map((text) => ({ category, text }));
}

async function main() {
  if (!process.env.POSTGRES_URL) {
    console.error('POSTGRES_URL not set. Aborting.');
    process.exit(1);
  }

  console.log('Seeding prompts...');
  for (const [key, template] of [
    ['caption', CAPTION_TEMPLATE],
    ['description', DESCRIPTION_TEMPLATE],
    ['tags', TAGS_TEMPLATE],
    ['breed', BREED_TEMPLATE],
    ['depart', DEPART_TEMPLATE],
    ['antibreed', ANTIBREED_TEMPLATE],
    ['subtract', SUBTRACT_TEMPLATE]
  ] as const) {
    await db
      .insert(prompts)
      .values({ key, template, version: 1 })
      .onConflictDoUpdate({
        target: prompts.key,
        set: { template, updatedAt: sql`now()` }
      });
    console.log(`  - upserted prompt "${key}"`);
  }

  console.log('Seeding ai_config...');
  for (const [field, { provider, model }] of Object.entries(defaultAiConfig)) {
    await db
      .insert(aiConfig)
      .values({ field, provider, model })
      .onConflictDoUpdate({
        target: aiConfig.field,
        // Only fill in rows that are missing; do not overwrite owner edits.
        set: { updatedAt: sql`ai_config.updated_at` }
      });
    console.log(`  - ensured ai_config["${field}"] (default ${provider}/${model})`);
  }

  console.log(`Seeding tag_taxonomy (${TAXONOMY.length} tags)...`);
  for (let i = 0; i < TAXONOMY.length; i++) {
    const t = TAXONOMY[i]!;
    await db
      .insert(tagTaxonomy)
      .values({ tag: t.tag, category: t.category, sortOrder: i })
      .onConflictDoUpdate({
        target: tagTaxonomy.tag,
        set: { category: t.category, sortOrder: i }
      });
  }
  console.log('Seeding site admin user...');
  const adminId = ownerId();
  const adminHandle = ownerHandle();
  await db
    .insert(users)
    .values({
      id: adminId,
      handle: adminHandle,
      provider: 'github',
      role: 'admin'
    })
    .onConflictDoUpdate({
      target: users.id,
      // Promote to admin on every reseed; leave handle/profile alone so the
      // OAuth callback can keep them fresh.
      set: { role: 'admin', updatedAt: new Date() }
    });
  console.log(`  - ensured admin user "${adminHandle}" (id ${adminId})`);

  console.log('Seeding about_fields defaults...');
  const aboutDefaults: { key: string; label: string; sortOrder: number }[] = [
    { key: 'intro', label: 'intro', sortOrder: 10 },
    { key: 'method', label: 'method', sortOrder: 20 },
    { key: 'rules', label: 'rules', sortOrder: 30 },
    { key: 'colophon', label: 'colophon', sortOrder: 40 },
    { key: 'contact', label: 'contact', sortOrder: 50 }
  ];
  for (const f of aboutDefaults) {
    await db
      .insert(aboutFields)
      .values({ ownerId: adminId, key: f.key, label: f.label, content: '', sortOrder: f.sortOrder })
      .onConflictDoUpdate({
        // Don't clobber owner content on reseed -- only ensure row exists
        // and the label/sortOrder stay synced with defaults.
        target: [aboutFields.ownerId, aboutFields.key],
        set: { label: f.label, sortOrder: f.sortOrder }
      });
    console.log(`  - ensured about_fields["${f.key}"]`);
  }

  console.log('Seeding gallery_config defaults...');
  for (const [key, value] of [
    ['default_sort', DEFAULT_SORT],
    ['default_shuffle_period', DEFAULT_SHUFFLE_PERIOD]
  ] as const) {
    await db
      .insert(galleryConfig)
      .values({ ownerId: adminId, key, value })
      .onConflictDoNothing({ target: [galleryConfig.ownerId, galleryConfig.key] });
    console.log(`  - ensured gallery_config["${key}"] (default ${value})`);
  }

  console.log(`Seeding constraint_cards (${CONSTRAINT_CARDS.length} cards)...`);
  for (const card of CONSTRAINT_CARDS) {
    await db
      .insert(constraintCards)
      .values({ category: card.category, text: card.text, active: true })
      .onConflictDoUpdate({
        target: [constraintCards.category, constraintCards.text],
        // Re-activate on reseed in case an owner toggled active=false and
        // we re-introduced the same card text; if you want to drop a card
        // permanently, remove it from CONSTRAINT_CARDS and run a manual
        // DELETE -- reseeding won't ressurect a deleted row.
        set: { active: true }
      });
  }
  console.log(`  - upserted ${CONSTRAINT_CARDS.length} constraint cards`);

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
