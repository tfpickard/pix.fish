/**
 * Seed prompts + tag_taxonomy. Idempotent: always upserts.
 *
 * Usage:
 *   POSTGRES_URL=... bun run db:seed
 */
import { db } from '../src/lib/db/client';
import { prompts, tagTaxonomy } from '../src/lib/db/schema';
import { sql } from 'drizzle-orm';

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

const TAGS_TEMPLATE = `You are tagging an image for a personal gallery so it can be filtered and found later.

Produce a mix of two kinds of tags:

1) TAXONOMY tags (source: "taxonomy"). Draw from this curated list, grouped by category:
{{tag_taxonomy}}

Only use tags from the list above for source="taxonomy". Use lower-case exactly as written.

2) FREEFORM tags (source: "freeform"). Short, specific descriptors of what is actually in this image (subjects, places, objects, notable details). Lower-case, kebab-case if multi-word. No sentences.

Aim for 6 to 14 tags total with a roughly even mix of taxonomy and freeform. Include a taxonomy tag only if it actually applies. Do not invent new taxonomy tags.

Return ONLY valid JSON in this shape, with no prose around it:
{
  "tags": [
    { "tag": "photograph",   "source": "taxonomy", "confidence": 0.95 },
    { "tag": "fire-escape",  "source": "freeform", "confidence": 0.8 }
  ]
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

async function main() {
  if (!process.env.POSTGRES_URL) {
    console.error('POSTGRES_URL not set. Aborting.');
    process.exit(1);
  }

  console.log('Seeding prompts...');
  for (const [key, template] of [
    ['caption', CAPTION_TEMPLATE],
    ['description', DESCRIPTION_TEMPLATE],
    ['tags', TAGS_TEMPLATE]
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
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
