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
  fishConfig,
  galleryConfig,
  prompts,
  remixIdioms,
  tagTaxonomy,
  users
} from '../src/lib/db/schema';
import { defaultAiConfig } from '../src/lib/ai/config';
import { DEFAULT_FISH_MORPH_CONFIG, fishConfigToFields } from '../src/lib/fish/config';
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

// feat/hud: dedicated nudity classifier for the batch NSFW scan. Distinct from
// the tags prompt so the scan can run cheaply on Haiku without rewriting tags.
// Output is parseable by parseTagsJson (reads `nsfw`; empty `tags` is fine).
const NSFW_TEMPLATE = `You are a single-purpose nudity classifier for an image gallery.

Look at the attached image and decide one thing: does it contain human nudity?
Set "nsfw": true if the image shows visible human nudity (exposed genitalia,
bare breasts, bare buttocks, or otherwise unclothed human bodies), and false
otherwise. Nudity is the ONLY criterion. Violence, gore, suggestive-but-clothed
imagery, drug use, and merely intense subject matter do NOT count and are false.
Err toward true when nudity is clearly identifiable; err toward false when you
cannot tell.

Do NOT use em dashes. Return ONLY valid JSON in this exact shape, no prose:
{
  "tags": [],
  "nsfw": false
}`;

// Phase 5 -- inspiration playground prompts. All return the same three-voice
// JSON shape as breed so the API can reuse parseVariantsJson and the
// playground can offer the owner three prompt options to copy.

const EQUALIZER_TEMPLATE = `You are generating image-generation PROMPTS steered toward a set of stylistic coordinates for a personal gallery.

The owner has set these axes (each runs from one pole to the other; the target tells you how far along that axis to aim):
{{axis_targets}}

HOUSE STYLE -- the gallery's mined caption grammar. Stay inside this voice; it is what makes the collection feel like one person made it:
{{grammar_style}}

Your job: invent THREE distinct image-generation prompts that a human would feed to an image model. Each must honour the axis targets above and read like it belongs in this gallery. Do not mention the axes or their numbers in the output; express them through subject, mood, palette, and composition.

Constraints:
  - Each prompt describes ONE concrete imagined image.
  - Do NOT use em dashes. Use commas, periods, or two hyphens (--).
  - Be specific. Avoid generic stock-photo language.

Return ONLY valid JSON in this exact shape, no prose around it:
{
  "variant1": "<image prompt>",
  "variant2": "<image prompt>",
  "variant3": "<image prompt>"
}`;

const SURPRISE_TEMPLATE = `You are an anti-prompt engine for a personal image gallery. Your one job is to ESCAPE it. This gallery has a tasteful, restrained house style: quiet documentary photography, a single human figure in soft natural light, muted natural palettes, calm minimal composition, "sincere" stillness. That restraint is the trap. The prompts you return should look like a GLITCH in this gallery, not another entry in it.

RECURRING MATERIAL -- a sample of the gallery's captions. Read it ONLY to learn what to flee:
{{motif_sample}}

FAR TERRITORY -- images already sitting farthest from the gallery's centre. Even these are too timid. Go well past them:
{{far_neighbor_captions}}

Privately note the gallery's habitual subjects, moods, palettes, media, and framings. Then invent THREE image prompts that VIOLATE as many of those habits as possible at once. Go for genuinely strange, uncanny, form-breaking images. Each prompt MUST combine at least THREE of these wrongness levers:
  - wrong SCALE (something absurdly huge or microscopic for its setting)
  - impossible PHYSICS or anatomy (floating, melting, mirrored, too many limbs, turned inside out)
  - wrong MEDIUM for this gallery (lurid 3D render, airbrushed van mural, medical diagram, baroque oil, anime cel, blacklight poster, claymation, CT scan)
  - violent or SYNTHETIC color (neon, iridescent, radioactive green, candy, oil-slick, chrome)
  - CROWDING or swarms where the gallery would show one quiet subject
  - ANACHRONISM or genre collision (a medieval saint wired with fibre optics, a deep-sea cathedral, a fast-food Valhalla)
  - the UNCANNY (mascots, taxidermy, mannequins, masks, dolls, things smiling wrong)

Push right to the edge of coherence. Weird, not random: each prompt is still ONE makeable image a person could actually generate, just one this gallery would never dare. Absolutely no tasteful restraint, no lone-figure-in-soft-light, no "quiet" anything, no "natural palette."

Constraints:
  - Do NOT name the levers or explain yourself; just deploy them.
  - Do NOT use em dashes. Use commas, periods, or two hyphens (--).

Return ONLY valid JSON in this exact shape, no prose around it:
{
  "variant1": "<image prompt>",
  "variant2": "<image prompt>",
  "variant3": "<image prompt>"
}`;

const WALK_STEP_TEMPLATE = `You are narrating a slow drift through image-prompt space, one step at a time.

SEED -- the image this walk started from:
{{seed_caption}}

PREVIOUS STEP -- the prompt from the step just before this one (may be blank on the first step, in which case drift gently from the seed):
{{previous_prompt}}

DRIFT INSTRUCTION: {{temperature_hint}}

Your job: produce the NEXT single image-generation prompt in the walk. It should feel like a natural neighbour of the previous step -- recognisably one move away, not a jump cut -- while obeying the drift instruction. Keep a thread of continuity (a recurring colour, object, or mood) so the whole walk reads as a journey rather than a shuffle.

Constraints:
  - ONE concrete imagined image.
  - Do NOT use em dashes. Use commas, periods, or two hyphens (--).
  - Do NOT reference "the walk", "the previous step", or "the seed" in the output.

Return ONLY valid JSON in this exact shape, no prose around it:
{
  "prompt": "<the next image prompt>"
}`;

const REVERSE_HAIKU_TEMPLATE = `You are inverting the usual relationship between image and haiku. Normally a haiku is written about an image; here you are given a haiku and must imagine the image it could caption.

HAIKU:
{{haiku}}

Your job: invent THREE image-generation prompts for images that this haiku could plausibly be the caption of. Honour the haiku's season, mood, and concrete images, but do not simply transcribe its words -- imagine the photograph or painting that lives behind it.

Constraints:
  - Each prompt describes ONE concrete imagined image.
  - Do NOT use em dashes. Use commas, periods, or two hyphens (--).
  - Be specific.

Return ONLY valid JSON in this exact shape, no prose around it:
{
  "variant1": "<image prompt>",
  "variant2": "<image prompt>",
  "variant3": "<image prompt>"
}`;

const REMIX_TEMPLATE = `You are recasting an existing image's CONCEPT into a different visual idiom, keeping what the image is ABOUT while changing how it would LOOK.

ORIGINAL CONCEPT -- the canonical caption of the image being remixed:
{{source_caption}}

TARGET IDIOM: {{idiom_label}}
IDIOM NOTES: {{idiom_description}}

Your job: invent THREE image-generation prompts that preserve the original concept (its subject, its situation, what it is about) but render it fully in the target idiom -- its palette, framing, materials, era, and sensibility. The concept stays; the visual language changes completely.

Constraints:
  - Keep the original subject recognisable; do not drift to a new subject.
  - Commit fully to the idiom; do not hedge.
  - Do NOT use em dashes. Use commas, periods, or two hyphens (--).

Return ONLY valid JSON in this exact shape, no prose around it:
{
  "variant1": "<image prompt>",
  "variant2": "<image prompt>",
  "variant3": "<image prompt>"
}`;

// Pool-generation prompts. Used by scripts/generate-remix-idioms.ts and
// scripts/generate-constraint-cards.ts respectively. Seeded into the DB so
// the owner can edit them via /admin/prompts without a redeploy.
// The Sonnet "family" pass uses REMIX_IDIOM_GEN_TEMPLATE directly; the Haiku
// "expand" pass replaces {{existing_families}} with a JSON list of the families
// already generated so it knows what territory is covered.

const REMIX_IDIOM_GEN_TEMPLATE = `You are building a large pool of VISUAL IDIOMS for an image-prompt remix engine.

Each idiom is a named visual style, era, or artistic movement that can be used to RECAST an image concept while keeping what the image is ABOUT. The pool must be diverse -- spanning photography, painting, illustration, cinema, graphic design, craft media, and cultural moments from many eras and regions.

{{existing_families}}

Generate {{n}} DISTINCT idioms NOT already in the list above. For each, produce:
  - key: a stable slug, lowercase kebab-case, no spaces (e.g. "weegee-tabloid")
  - label: a short human-readable name, 2 to 5 words (e.g. "Weegee tabloid press")
  - description: 1 to 2 sentences of concrete visual notes -- palette, framing, materials, era, sensibility. This is fed directly to an image-generation model, so be specific and evocative. No vague praise. No em dashes.

Quality rules:
  - Each idiom must be visually DISTINCT from every other in the list.
  - Labels and descriptions must contain NO em dashes. Use commas, periods, or two hyphens (--) instead.
  - Avoid generic labels like "cinematic" or "vintage" without a specific referent.
  - Cover a wide range: not just Western art history -- include East Asian, South Asian, African, Latin American, and other regional traditions.

Return ONLY valid JSON -- an array of objects, no prose around it:
[
  { "key": "...", "label": "...", "description": "..." },
  ...
]`;

const CONSTRAINT_CARD_GEN_TEMPLATE = `You are expanding a constraint-card deck for an image-prompt composition tool.

Each card is a SHORT, CONCRETE constraint in ONE of these categories:
  - medium: a physical or digital material / process (e.g. "cyanotype on cotton paper")
  - subject_archetype: a character type caught in a specific moment (e.g. "a saint disguised as a janitor")
  - modifier: a visual rule to apply to the scene (e.g. "lit from below")
  - mood: an emotional or atmospheric quality (e.g. "tender menace")
  - idiom: a named visual style or era (e.g. "Saul Leiter color slide")
  - composition: a framing or spatial rule (e.g. "horizon line halves the image")

CATEGORY TO GENERATE: {{category}}

EXISTING CARDS IN THIS CATEGORY (do not duplicate these):
{{existing_cards}}

Generate {{n}} NEW cards for category "{{category}}" that are NOT already in the list above. Each card text must:
  - Be SHORT -- one clause or short sentence, not a paragraph.
  - Be CONCRETE -- a reader knows immediately what to do with it.
  - Contain NO em dashes. Use commas, periods, or two hyphens (--) instead.
  - Feel like it belongs in a deck alongside the existing cards -- same absurdist-but-tasteful register.

Return ONLY valid JSON -- an array of strings, no prose:
["card text", "card text", ...]`;

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

// Phase 5: visual idioms the remix engine recasts a concept into. `key` is the
// stable identifier the API takes; `label` is what the menu shows; the
// `description` is fed to the model as idiom notes so it commits hard.
type Idiom = { key: string; label: string; description: string };
const REMIX_IDIOMS: Idiom[] = [
  {
    key: 'national-geographic',
    label: 'National Geographic, late 1970s',
    description:
      'Saturated Kodachrome documentary photography, available light, a human or animal subject met at eye level, faint caption-worthy dignity, slight grain.'
  },
  {
    key: 'wes-anderson',
    label: 'Wes Anderson still',
    description:
      'Dead-center symmetry, flat frontal framing, pastel palette, deadpan styling, meticulous props, a faint melancholy under the whimsy.'
  },
  {
    key: 'soviet-propaganda',
    label: 'Soviet propaganda poster',
    description:
      'Bold red and ochre, heroic low angle, geometric constructivist composition, sans-serif Cyrillic-style energy, idealised labour and light.'
  },
  {
    key: 'snes-box-art',
    label: '1990s SNES box art',
    description:
      'Airbrushed illustration, dramatic action pose, glossy highlights, lurid gradients, a sky full of impossible color, early-90s console packaging energy.'
  },
  {
    key: 'le-guin-cover',
    label: 'Le Guin paperback cover',
    description:
      'Hand-painted 1970s science-fiction paperback art, muted earth tones, a small figure against a vast strange landscape, quiet wonder over spectacle.'
  },
  {
    key: 'diane-arbus',
    label: 'Diane Arbus',
    description:
      'Square black-and-white, flash-lit frontal portrait, an ordinary subject made uncanny, unflinching eye contact, tender discomfort.'
  },
  {
    key: 'hopper',
    label: 'Edward Hopper, late afternoon',
    description:
      'Flat raking light, large quiet color planes, urban solitude, a single still figure, the held silence of an empty afternoon.'
  },
  {
    key: 'saul-leiter',
    label: 'Saul Leiter color slide',
    description:
      'Misted city color, shooting through glass and steam, layered reflections, muted reds and greens, fragments of figures half-hidden.'
  },
  {
    key: 'ghibli-matte',
    label: 'Studio Ghibli matte painting',
    description:
      'Hand-painted background art, lush skies, soft cumulus, tender naturalism, a small human presence inside a generous world.'
  },
  {
    key: 'lynch-motel',
    label: 'David Lynch motel still',
    description:
      'Tungsten-lit interior, deep shadow, ominous calm, heavy red curtains and worn surfaces, dread folded into the mundane.'
  },
  {
    key: 'becher-inventory',
    label: 'Bernd and Hilla Becher inventory',
    description:
      'Deadpan black-and-white, flat overcast light, the subject centred and isolated like a typological specimen, no drama, total clarity.'
  },
  {
    key: 'neorealism-1948',
    label: 'Italian neorealism, 1948',
    description:
      'Grainy black-and-white, street-level natural light, non-actors, post-war ordinariness, documentary tenderness toward everyday hardship.'
  }
];

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
    ['nsfw', NSFW_TEMPLATE],
    ['breed', BREED_TEMPLATE],
    ['depart', DEPART_TEMPLATE],
    ['antibreed', ANTIBREED_TEMPLATE],
    ['subtract', SUBTRACT_TEMPLATE],
    ['equalizer', EQUALIZER_TEMPLATE],
    ['surprise', SURPRISE_TEMPLATE],
    ['walk_step', WALK_STEP_TEMPLATE],
    ['reverse_haiku', REVERSE_HAIKU_TEMPLATE],
    ['remix', REMIX_TEMPLATE],
    ['remix_idiom_gen', REMIX_IDIOM_GEN_TEMPLATE],
    ['constraint_card_gen', CONSTRAINT_CARD_GEN_TEMPLATE]
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

  console.log('Seeding fish_config...');
  for (const [field, value] of Object.entries(fishConfigToFields(DEFAULT_FISH_MORPH_CONFIG))) {
    await db
      .insert(fishConfig)
      .values({ field, value })
      .onConflictDoUpdate({
        target: fishConfig.field,
        // Only fill in rows that are missing; do not overwrite admin edits.
        set: { updatedAt: sql`fish_config.updated_at` }
      });
    console.log(`  - ensured fish_config["${field}"] (default ${value})`);
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
        // DELETE -- reseeding won't resurrect a deleted row.
        set: { active: true }
      });
  }
  console.log(`  - upserted ${CONSTRAINT_CARDS.length} constraint cards`);

  console.log(`Seeding remix_idioms (${REMIX_IDIOMS.length} idioms)...`);
  for (const idiom of REMIX_IDIOMS) {
    await db
      .insert(remixIdioms)
      .values({ key: idiom.key, label: idiom.label, description: idiom.description, active: true })
      .onConflictDoUpdate({
        target: remixIdioms.key,
        // Refresh label/description on reseed but leave `active` alone so an
        // owner who toggled an idiom off stays off.
        set: { label: idiom.label, description: idiom.description }
      });
  }
  console.log(`  - upserted ${REMIX_IDIOMS.length} remix idioms`);

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
