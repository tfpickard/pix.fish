import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
  index,
  vector
} from 'drizzle-orm/pg-core';
import type { ImageDerivatives } from '@/lib/images/derivatives';

// ----------------------------------------------------------------------------
// Phase 1 tables
// ----------------------------------------------------------------------------

// Users. One row per signed-in identity. PK is provider-scoped so identities
// from different providers can never collide: GitHub keeps its bare numeric
// `profile.id` as text (preserving existing rows + the OWNER_GITHUB_ID match),
// while newer providers are namespaced -- `google:<sub>`, `apple:<sub>`, and
// email/password users get an OPAQUE `email:<uuid>` id. The id is intentionally
// NOT the raw email: it flows into `images.ownerId`, which is serialized in the
// public image API, so a raw-email id would leak the address. The address lives
// only in the `email` column (uniqueness enforced by users_email_provider_uniq
// below). `handle` is the public, URL-safe identifier used in /u/<handle>/<slug>;
// collisions get a numeric suffix at first sign-in. `role` gates site-admin
// features: the bootstrap user (`OWNER_GITHUB_ID`) is upserted 'admin' on first run.
export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    handle: text('handle').notNull().unique(),
    displayName: text('display_name'),
    avatarUrl: text('avatar_url'),
    email: text('email'),
    provider: text('provider').notNull().default('github'),
    role: text('role').notNull().default('user'), // 'user' | 'admin'
    // Only set for email/password ('email' provider) users: scrypt digest in the
    // `scrypt$<salt-hex>$<hash-hex>` format written by src/lib/password.ts. Null
    // for OAuth identities (GitHub/Google/Apple), which have no local password.
    passwordHash: text('password_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    // One email/password account per address, enforced at the DB. Partial +
    // lower() so it applies ONLY to 'email' provider rows (OAuth rows may
    // legitimately share or omit an email) and is case-insensitive. The email
    // user id is opaque (`email:<uuid>`), so this index -- not the PK -- is what
    // guarantees no two registrations claim the same address.
    emailProviderUniq: uniqueIndex('users_email_provider_uniq')
      .on(sql`lower(${t.email})`)
      .where(sql`${t.provider} = 'email'`)
  })
);

export const images = pgTable(
  'images',
  {
    id: serial('id').primaryKey(),
    slug: text('slug').notNull(),
    slugHistory: text('slug_history').array().notNull().default([]),
    blobUrl: text('blob_url').notNull(),
    blobKey: text('blob_key').notNull(),
    mime: text('mime'),
    width: integer('width'),
    height: integer('height'),
    takenAt: timestamp('taken_at', { withTimezone: true }),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    exif: jsonb('exif'),
    palette: text('palette').array(),
    manualCaption: text('manual_caption'),
    // NSFW flag set by the AI tag pass or manual override. `nsfwSource`
    // tracks which side last touched it so reprocess passes don't clobber
    // an owner's manual call. Default-hide on the public stream is enforced
    // at the query layer.
    isNsfw: boolean('is_nsfw').notNull().default(false),
    nsfwSource: text('nsfw_source'), // 'auto' | 'manual' | null (legacy rows)
    // --- Gate-0 contract: parallel-build feature columns ---------------------
    // Added once at Gate 0 so the six worktrees never edit the images table
    // concurrently. Each is nullable / defaulted so existing rows backfill
    // harmlessly and the column lies dormant until its phase fills it.
    // feat/hud: normalized 0..1 surprisal, written by scripts/compute-entropy.ts.
    // Null == not yet scored; the 'surprising-first' sort treats null as least.
    surprisal: real('surprisal'),
    // feat/alive: generation 0 == not bred; lineage edges live in image_lineage.
    // archivedAt hides a row from public surfaces without hard-deleting it.
    generation: integer('generation').notNull().default(0),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    // feat/basement: basement rows are gated server-side (mirrors the NSFW gate);
    // never served unless the unlock flag is present.
    basement: boolean('basement').notNull().default(false),
    // Precomputed WebP derivatives ([{ w, url }], ascending by width) generated
    // offline by scripts/generate-derivatives.ts. Null == not yet processed;
    // consumers fall back to the original blobUrl. Additive and best-effort: the
    // grid serves the small derivative so it never ships the full-res original.
    derivatives: jsonb('derivatives').$type<ImageDerivatives>(),
    // Phase 3 character detection: stamped when characters.detect has examined
    // this image, INCLUDING when it found no figures. Null == never examined.
    // Lets non-force detect runs skip figureless images (which produce no crop
    // rows) instead of re-billing a vision call every pass; --force re-detects
    // regardless.
    charactersDetectedAt: timestamp('characters_detected_at', { withTimezone: true })
  },
  (t) => ({
    uploadedAtIdx: index('images_uploaded_at_idx').on(t.uploadedAt),
    slugHistoryIdx: index('images_slug_history_idx').using('gin', t.slugHistory),
    // Per-user slug namespace. Two users can both have /u/alice/sunset and
    // /u/bob/sunset; the legacy /<slug> redirect resolves to whichever owner
    // currently holds it (with slug_history covering renames).
    ownerSlugUniq: uniqueIndex('images_owner_slug_uniq').on(t.ownerId, t.slug),
    nsfwIdx: index('images_is_nsfw_idx').on(t.isNsfw),
    surprisalIdx: index('images_surprisal_idx').on(t.surprisal),
    archivedIdx: index('images_archived_idx').on(t.archivedAt),
    basementIdx: index('images_basement_idx').on(t.basement)
  })
);

export const captions = pgTable(
  'captions',
  {
    id: serial('id').primaryKey(),
    imageId: integer('image_id')
      .notNull()
      .references(() => images.id, { onDelete: 'cascade' }),
    variant: integer('variant').notNull(),
    text: text('text').notNull(),
    provider: text('provider'),
    model: text('model'),
    isSlugSource: boolean('is_slug_source').notNull().default(false),
    locked: boolean('locked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    imageIdx: index('captions_image_id_idx').on(t.imageId)
  })
);

export const descriptions = pgTable(
  'descriptions',
  {
    id: serial('id').primaryKey(),
    imageId: integer('image_id')
      .notNull()
      .references(() => images.id, { onDelete: 'cascade' }),
    variant: integer('variant').notNull(),
    text: text('text').notNull(),
    provider: text('provider'),
    model: text('model'),
    locked: boolean('locked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    imageIdx: index('descriptions_image_id_idx').on(t.imageId)
  })
);

export const tags = pgTable(
  'tags',
  {
    id: serial('id').primaryKey(),
    imageId: integer('image_id')
      .notNull()
      .references(() => images.id, { onDelete: 'cascade' }),
    tag: text('tag').notNull(),
    confidence: doublePrecision('confidence'),
    source: text('source').notNull(), // 'taxonomy' | 'freeform'
    provider: text('provider'),
    model: text('model')
  },
  (t) => ({
    uniqPerImage: uniqueIndex('tags_image_tag_uniq').on(t.imageId, t.tag),
    tagIdx: index('tags_tag_idx').on(t.tag)
  })
);

export const tagTaxonomy = pgTable('tag_taxonomy', {
  id: serial('id').primaryKey(),
  tag: text('tag').notNull().unique(),
  category: text('category'),
  sortOrder: integer('sort_order').notNull().default(0)
});

export const prompts = pgTable('prompts', {
  id: serial('id').primaryKey(),
  key: text('key').notNull().unique(), // 'caption' | 'description' | 'tags'
  template: text('template').notNull(),
  version: integer('version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// Personal access tokens for the public REST API. Distinct from
// providerKeys (which holds outbound BYO credentials for Anthropic/OpenAI).
// Only the SHA-256 hash is stored; the raw token is shown once at creation.
export const apiKeys = pgTable('api_keys', {
  id: serial('id').primaryKey(),
  ownerId: text('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  label: text('label'),
  keyHash: text('key_hash').notNull().unique(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// User-supplied outbound AI provider credentials (BYO key). One row per
// (owner, provider) pair. `keyEncrypted` is AES-GCM ciphertext stored as
// base64(iv || tag || ciphertext) using a key derived from AUTH_SECRET via
// PBKDF2; the row is useless without the app secret. Plaintext is never
// persisted, returned to the client, or logged. The provider literal is
// constrained to the supported set so the per-user key lookup stays a
// trivial table read.
export const providerKeys = pgTable(
  'provider_keys',
  {
    id: serial('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(), // 'anthropic' | 'openai'
    label: text('label'),
    keyEncrypted: text('key_encrypted').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    // One key per user per provider. Adding a second key for the same
    // provider is rotation: replace, don't append.
    ownerProviderUniq: uniqueIndex('provider_keys_owner_provider_uniq').on(t.ownerId, t.provider)
  })
);

// ----------------------------------------------------------------------------
// Phase 2 tables
// ----------------------------------------------------------------------------

// Embeddings live in pgvector. Phase 2 writes `kind='caption'` for images (text
// embedding of the slug-source caption via OpenAI text-embedding-3-small, 1536
// dims). `image` and `combined` kinds are reserved for later phases that add
// CLIP or multimodal models.
//
// Universe (Phase U1) generalizes this into a node-type-aware store: a row
// belongs to exactly one subject -- an image (`subject_type='image'`,
// `image_id` set) or a lore fragment (`subject_type='lore'`,
// `lore_fragment_id` set). This lets clerk-authored dossiers co-locate in the
// same vector space as the images and become searchable through the same
// pgvector path, without forking a parallel embedding store. The CHECK keeps
// exactly one subject FK populated; the two unique indexes keep reprocessing
// idempotent per subject via onConflictDoUpdate.
export const embeddings = pgTable(
  'embeddings',
  {
    id: serial('id').primaryKey(),
    // Nullable now that a row may instead point at a lore fragment. Existing
    // image rows keep image_id set and back-fill subject_type='image'.
    imageId: integer('image_id').references(() => images.id, { onDelete: 'cascade' }),
    loreFragmentId: integer('lore_fragment_id').references(() => loreFragments.id, {
      onDelete: 'cascade'
    }),
    subjectType: text('subject_type').notNull().default('image'), // 'image' | 'lore'
    kind: text('kind').notNull(), // 'image' | 'caption' | 'combined'
    provider: text('provider'),
    model: text('model'),
    vec: vector('vec', { dimensions: 1536 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    imageKindUniq: uniqueIndex('embeddings_image_kind_uniq').on(t.imageId, t.kind),
    loreKindUniq: uniqueIndex('embeddings_lore_kind_uniq').on(t.loreFragmentId, t.kind),
    imageIdx: index('embeddings_image_id_idx').on(t.imageId),
    loreIdx: index('embeddings_lore_fragment_id_idx').on(t.loreFragmentId),
    // Exactly one subject FK is set AND subject_type agrees with it. NULLs are
    // distinct in the unique indexes above, so this CHECK is what actually
    // forbids a row with neither/both FKs, and it also rules out a semantically
    // invalid row like subject_type='lore' with image_id set -- so the
    // subject_type='image'/'lore' query filters can never miss a row.
    subjectOneOf: check(
      'embeddings_subject_one_of',
      sql`(image_id IS NOT NULL AND lore_fragment_id IS NULL AND subject_type = 'image')
        OR (image_id IS NULL AND lore_fragment_id IS NOT NULL AND subject_type = 'lore')`
    )
  })
);

// ----------------------------------------------------------------------------
// Phase 3 tables
// ----------------------------------------------------------------------------

// Anonymous thumbs up/down. Unique per (image_id, ip_hash) -- one reaction
// per IP per image. `kind` can be swapped by re-posting; DELETE by re-posting
// the same kind (toggle). fingerprint is a client-generated UUID persisted in
// localStorage as a secondary de-dupe signal.
export const reactions = pgTable(
  'reactions',
  {
    id: serial('id').primaryKey(),
    imageId: integer('image_id')
      .notNull()
      .references(() => images.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // 'up' | 'down'
    ipHash: text('ip_hash').notNull(),
    fingerprint: text('fingerprint'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    uniqPerIp: uniqueIndex('reactions_image_ip_uniq').on(t.imageId, t.ipHash),
    imageIdx: index('reactions_image_id_idx').on(t.imageId)
  })
);

// Comments. status flows: pending -> approved | rejected.
// Approved comments are publicly visible; pending ones are hidden until
// the owner approves from the moderation queue. Signed-in users skip
// moderation (status defaults to 'approved' at the route layer for them);
// guests still default to 'pending' and may supply an optional author_name
// plus auto-captured city/region/country from Vercel edge headers.
export const comments = pgTable(
  'comments',
  {
    id: serial('id').primaryKey(),
    imageId: integer('image_id')
      .notNull()
      .references(() => images.id, { onDelete: 'cascade' }),
    // Optional signed-in user link. set null on user delete so a removed
    // account doesn't cascade-delete their comment history; the row just
    // re-falls-back to the guest rendering branch.
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    authorName: text('author_name'),
    body: text('body').notNull(),
    status: text('status').notNull().default('pending'), // 'pending' | 'approved' | 'rejected'
    ipHash: text('ip_hash').notNull(),
    // Guest geo (Vercel edge headers). Nullable: signed-in users skip
    // capture, and dev / non-Vercel hosts won't have the headers. Country
    // is ISO-3166 alpha-2.
    geoCity: text('geo_city'),
    geoRegion: text('geo_region'),
    geoCountry: text('geo_country'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    imageIdx: index('comments_image_id_idx').on(t.imageId),
    statusIdx: index('comments_status_idx').on(t.status),
    userIdx: index('comments_user_id_idx').on(t.userId)
  })
);

// Visitor-submitted reports for offensive content.
// Separate FK columns (rather than polymorphic targetId) so the DB can enforce
// referential integrity and cascade deletes when an image or comment is removed.
export const reports = pgTable('reports', {
  id: serial('id').primaryKey(),
  targetType: text('target_type').notNull(), // 'image' | 'comment' -- for admin display
  imageId: integer('image_id').references(() => images.id, { onDelete: 'cascade' }),
  commentId: integer('comment_id').references(() => comments.id, { onDelete: 'cascade' }),
  reason: text('reason'),
  ipHash: text('ip_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// Phase F: anonymous-friendly "shelves". Visitors save images to a
// collection by ip_hash + fingerprint; signed-in users use their user.id
// as ownerHash. The slug is human-readable (adjective-noun-NNNN) so
// shelves are shareable without leaking IDs. `title` defaults to "shelf"
// at the API layer when null. Cascading delete on items follows the
// images table -- removing an image from /admin/gallery removes it from
// every shelf.
export const collections = pgTable(
  'collections',
  {
    id: serial('id').primaryKey(),
    slug: text('slug').notNull().unique(),
    title: text('title'),
    // For anonymous visitors: ip_hash. For signed-in users: user.id.
    // The same column covers both so authorization is one comparison.
    ownerHash: text('owner_hash').notNull(),
    // Secondary dedupe (localStorage UUID) -- mirrors the reactions
    // pattern. Lets a visitor on a shared IP keep their own shelf.
    fingerprint: text('fingerprint'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    ownerHashIdx: index('collections_owner_hash_idx').on(t.ownerHash)
  })
);

export const collectionItems = pgTable(
  'collection_items',
  {
    id: serial('id').primaryKey(),
    collectionId: integer('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    imageId: integer('image_id')
      .notNull()
      .references(() => images.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    uniq: uniqueIndex('collection_items_uniq').on(t.collectionId, t.imageId),
    collectionIdx: index('collection_items_collection_idx').on(t.collectionId)
  })
);

// ----------------------------------------------------------------------------
// Phase 4 tables
// ----------------------------------------------------------------------------

// Per-field provider routing. Natural key on `field` so writes are upserts.
// Seeded from src/lib/ai/config.ts defaults on first run so behavior stays
// byte-identical until the owner changes a row via /admin/ai.
export const aiConfig = pgTable('ai_config', {
  id: serial('id').primaryKey(),
  field: text('field').notNull().unique(), // 'captions' | 'descriptions' | 'tags' | 'embeddings'
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// Tunables for the pix-fish mascot's Lorenz-driven shape + size morph. Global
// (site-wide, not per-owner): the mascot renders the same for every visitor.
// Key/value singleton -- one row per parameter, value stored as text and parsed
// at read time. Editable at /admin/fish; see src/lib/fish/config.ts for the
// authoritative parameter list and defaults.
export const fishConfig = pgTable('fish_config', {
  id: serial('id').primaryKey(),
  field: text('field').notNull().unique(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// Outbound webhook subscriptions. `secret` is shown once at creation so the
// owner can record it; rotation is delete+recreate until usage warrants a
// real rotation UI. Per-user: each user manages outbound webhooks for
// events on *their* images. Site-admin platform webhooks live here too,
// distinguished by the owner's role.
export const webhooks = pgTable('webhooks', {
  id: serial('id').primaryKey(),
  ownerId: text('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  secret: text('secret').notNull(),
  events: text('events').array().notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// One row per attempted delivery; retries add new rows so the owner gets full
// history. `responseBody` is truncated to 2 KB before insert.
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: serial('id').primaryKey(),
    webhookId: integer('webhook_id')
      .notNull()
      .references(() => webhooks.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    payload: jsonb('payload').notNull(),
    attempt: integer('attempt').notNull().default(1),
    status: text('status').notNull(), // 'pending' | 'success' | 'failed'
    responseStatus: integer('response_status'),
    responseBody: text('response_body'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    webhookCreatedIdx: index('webhook_deliveries_webhook_created_idx').on(t.webhookId, t.createdAt)
  })
);

// Background job queue drained by /api/cron/jobs. We lease rows with a
// visibility timeout (`lockedAt`) rather than FOR UPDATE so a Vercel function
// dying mid-handler doesn't orphan rows until the DB session expires.
export const jobs = pgTable(
  'jobs',
  {
    id: serial('id').primaryKey(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('pending'), // 'pending' | 'processing' | 'done' | 'failed'
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    // Partial indexes so cron scans are cheap as the table grows.
    pendingIdx: index('jobs_pending_idx')
      .on(t.runAt)
      .where(sql`status = 'pending'`),
    processingIdx: index('jobs_processing_idx')
      .on(t.lockedAt)
      .where(sql`status = 'processing'`)
  })
);

// Cached UMAP projection. The handler inserts a new row per run; read paths
// select the newest one whose `params` match the requested cache key.
export const umapProjections = pgTable(
  'umap_projections',
  {
    id: serial('id').primaryKey(),
    pointCount: integer('point_count').notNull(),
    points: jsonb('points').notNull(), // [{ imageId, x, y }]
    params: jsonb('params').notNull(), // { nNeighbors, minDist, kind }
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    createdAtIdx: index('umap_projections_created_at_idx').on(t.createdAt)
  })
);

// User-composed prompt variants. Promoting one overwrites `prompts.template`
// for the matching key and bumps `prompts.version`; `fragments` is preserved
// so the composer can round-trip edits. Currently only site admins promote
// to the global `prompts` table, but every user can keep their own variants.
export const savedPrompts = pgTable('saved_prompts', {
  id: serial('id').primaryKey(),
  ownerId: text('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  key: text('key').notNull(), // matches prompts.key
  template: text('template').notNull(),
  fragments: jsonb('fragments'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// Per-user about-page fields. Each row is one named field (key = stable
// slug) with a display label, body text, and sort order. The site admin's
// rows back the global /about page; non-admin users see their own fields
// at /u/<handle>/about (future).
export const aboutFields = pgTable(
  'about_fields',
  {
    id: serial('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    label: text('label').notNull(),
    content: text('content').notNull().default(''),
    sortOrder: integer('sort_order').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    ownerKeyUniq: uniqueIndex('about_fields_owner_key_uniq').on(t.ownerId, t.key)
  })
);

// Per-user gallery defaults. Key/value store covering `default_sort` and
// `default_shuffle_period`. The site-admin row backs the public landing
// page; signed-in users override their own /u/<handle> view. Visitors
// further override on the client via localStorage.
export const galleryConfig = pgTable(
  'gallery_config',
  {
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: text('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    pk: uniqueIndex('gallery_config_owner_key_pk').on(t.ownerId, t.key)
  })
);

// ----------------------------------------------------------------------------
// Phase 5 tables -- inspiration playground
// ----------------------------------------------------------------------------

// Caption grammar mined from the corpus. One row per (owner, template); the
// derive-grammar script upserts so re-runs refresh frequencies without
// duplicating templates. `version` is metadata for tracing which run wrote a
// row; reads currently take everything for an owner regardless of version.
export const grammarSlots = pgTable(
  'grammar_slots',
  {
    id: serial('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    template: text('template').notNull(),
    frequency: integer('frequency').notNull().default(1),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    ownerTemplateUniq: uniqueIndex('grammar_slots_owner_template_uniq').on(t.ownerId, t.template),
    ownerIdx: index('grammar_slots_owner_idx').on(t.ownerId)
  })
);

// Per-slot fillers with weights. Slot names ("mundane_noun" etc.) come from
// the LLM pass in derive-grammar; the same slot name appears in
// grammar_slots.template as [slot_name].
export const grammarFillers = pgTable(
  'grammar_fillers',
  {
    id: serial('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    slotName: text('slot_name').notNull(),
    filler: text('filler').notNull(),
    weight: doublePrecision('weight').notNull().default(1),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    ownerSlotFillerUniq: uniqueIndex('grammar_fillers_owner_slot_filler_uniq').on(
      t.ownerId,
      t.slotName,
      t.filler
    ),
    ownerSlotIdx: index('grammar_fillers_owner_slot_idx').on(t.ownerId, t.slotName)
  })
);

// Constraint cards for the dice mechanic. Global (no owner_id) the same way
// tag_taxonomy is global -- shared vocabulary, edited via the seed script
// for now. `active` lets the owner toggle a card off without deleting it.
export const constraintCards = pgTable(
  'constraint_cards',
  {
    id: serial('id').primaryKey(),
    category: text('category').notNull(),
    text: text('text').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    categoryTextUniq: uniqueIndex('constraint_cards_category_text_uniq').on(t.category, t.text),
    categoryIdx: index('constraint_cards_category_idx').on(t.category)
  })
);

// Interpretable axes of the gallery for the vibe equalizer. The derivation
// approach (tag-cluster vs PCA vs k-means+LLM) is chosen by the owner after
// running scripts/vibe-axes.ts; whichever they pick is written here. Global
// (no owner_id) like constraint_cards -- the equalizer steers the site
// admin's corpus. `negativePole`/`positivePole` are the human-readable ends a
// slider runs between; the LLM is told the target value per axis.
export const vibeAxes = pgTable(
  'vibe_axes',
  {
    id: serial('id').primaryKey(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    description: text('description'),
    negativePole: text('negative_pole').notNull(),
    positivePole: text('positive_pole').notNull(),
    ordering: integer('ordering').notNull().default(0),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    keyUniq: uniqueIndex('vibe_axes_key_uniq').on(t.key)
  })
);

// Visual idioms the remix engine can recast a concept into ("Wes Anderson
// still", "Soviet propaganda poster"). Global + seedable like constraint
// cards; `active` toggles one off without deleting it.
export const remixIdioms = pgTable(
  'remix_idioms',
  {
    id: serial('id').primaryKey(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    description: text('description').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    keyUniq: uniqueIndex('remix_idioms_key_uniq').on(t.key)
  })
);

// Parent -> child provenance. An image can have multiple parents (the remix
// engine can fuse concepts), so this is a join table rather than a column on
// images. `promptUsed`/`dialectUsed` record what produced the child, surfaced
// on hovering an edge in the lineage graph. Both FKs cascade so deleting an
// image cleans up its edges.
export const imageLineage = pgTable(
  'image_lineage',
  {
    id: serial('id').primaryKey(),
    childImageId: integer('child_image_id')
      .notNull()
      .references(() => images.id, { onDelete: 'cascade' }),
    parentImageId: integer('parent_image_id')
      .notNull()
      .references(() => images.id, { onDelete: 'cascade' }),
    promptUsed: text('prompt_used'),
    dialectUsed: text('dialect_used'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    childParentUniq: uniqueIndex('image_lineage_child_parent_uniq').on(
      t.childImageId,
      t.parentImageId
    ),
    childIdx: index('image_lineage_child_idx').on(t.childImageId),
    parentIdx: index('image_lineage_parent_idx').on(t.parentImageId)
  })
);

// === Gate-0 contract: parallel-build feature tables =========================
// Added once at Gate 0 so the parallel worktrees never edit schema.ts or
// drizzle/ numbering concurrently. Each feature owns exactly one section; the
// table stays empty until its phase fills it. See CONTRACTS.md.

// feat/hud: collection temperature time series. One scalar per computed run so
// dispersion history can be charted. value is e.g. mean pairwise cosine.
export const collectionTemperature = pgTable(
  'collection_temperature',
  {
    id: serial('id').primaryKey(),
    value: real('value').notNull(),
    pointCount: integer('point_count').notNull().default(0),
    meta: jsonb('meta').$type<Record<string, unknown>>(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    computedIdx: index('collection_temperature_computed_idx').on(t.computedAt)
  })
);

// feat/manifold: 3D embedding projection. Mirrors umap_projections but stores
// (x,y,z) and a fixed RNG seed so a layout is reproducible run-to-run.
export const manifoldProjections = pgTable(
  'manifold_projections',
  {
    id: serial('id').primaryKey(),
    seed: integer('seed').notNull(),
    points: jsonb('points')
      .$type<Array<{ imageId: number; x: number; y: number; z: number }>>()
      .notNull(),
    pointCount: integer('point_count').notNull(),
    params: jsonb('params').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    createdIdx: index('manifold_projections_created_idx').on(t.createdAt)
  })
);

// feat/geodesics: kNN graph over caption embeddings. One row per directed edge;
// dist is the cosine-distance weight. Unique on (src,dst) so rebuilds upsert.
//
// Universe (Phase U1) adds src_type/dst_type as a forward-compatible seam so
// the graph can hold lore<->image / lore<->lore edges in Phase 2 (the ripple
// loop). Both default to 'image', so every existing row and every existing
// image-only caller (findPath, getEdgesForNodes*, /api/path, /connect) keeps
// behaving exactly as before. The image FK on src_id/dst_id is intentionally
// retained for Phase 1 -- relaxing it for a polymorphic id space is Phase 2
// work and is not needed until lore edges are actually written.
export const knnEdges = pgTable(
  'knn_edges',
  {
    id: serial('id').primaryKey(),
    srcId: integer('src_id')
      .notNull()
      .references(() => images.id, { onDelete: 'cascade' }),
    dstId: integer('dst_id')
      .notNull()
      .references(() => images.id, { onDelete: 'cascade' }),
    srcType: text('src_type').notNull().default('image'), // 'image' | 'lore'
    dstType: text('dst_type').notNull().default('image'), // 'image' | 'lore'
    dist: real('dist').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    srcIdx: index('knn_edges_src_idx').on(t.srcId),
    srcDstUniq: uniqueIndex('knn_edges_src_dst_uniq').on(t.srcId, t.dstId)
  })
);

// feat/stigmergy: per-image decayed attention. One row per image; read-time
// exponential decay is applied in code from (value, lastUpdatedAt). No cron.
//
// Substrate 1 (traffic ledger): `lifetime` is a monotonic sum of the same dwell
// weight that feeds `value`, but it NEVER decays. `value` answers "what is hot
// right now" (drift bias); `lifetime` answers "how much has this specimen been
// handled, ever" -- the signal erosion needs, because wear does not heal.
export const imageAttention = pgTable('image_attention', {
  imageId: integer('image_id')
    .primaryKey()
    .references(() => images.id, { onDelete: 'cascade' }),
  value: real('value').notNull().default(0),
  lifetime: real('lifetime').notNull().default(0),
  lastUpdatedAt: timestamp('last_updated_at', { withTimezone: true }).notNull().defaultNow()
});

// === end Gate-0 contract tables ============================================

// ----------------------------------------------------------------------------
// Substrate 1 (traffic ledger): per-edge traversal telemetry
// ----------------------------------------------------------------------------
//
// The sibling of `image_attention` for EDGES rather than nodes. Records which
// image->image edges visitors actually walk (via /connect, /drift, /daily),
// which is thrown away today. `value` decays on the same 3-day half-life as
// attention (what routes are walked lately); `lifetime` is a monotonic
// traversal count (what routes have ever been worn). Directed: a->b is distinct
// from b->a. Read by the desire-paths feature; this table only accumulates.
//
// Privacy: identical posture to image_attention -- no PII, only image-id pairs
// and aggregate weights. Ingest is consent-gated + rate-limited at /api/traffic.
export const pathTraffic = pgTable(
  'path_traffic',
  {
    id: serial('id').primaryKey(),
    srcId: integer('src_id')
      .notNull()
      .references(() => images.id, { onDelete: 'cascade' }),
    dstId: integer('dst_id')
      .notNull()
      .references(() => images.id, { onDelete: 'cascade' }),
    value: real('value').notNull().default(0),
    lifetime: real('lifetime').notNull().default(0),
    lastUpdatedAt: timestamp('last_updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    srcIdx: index('path_traffic_src_idx').on(t.srcId),
    srcDstUniq: uniqueIndex('path_traffic_src_dst_uniq').on(t.srcId, t.dstId)
  })
);

// Desire paths: the routes visitors actually walk, promoted from path_traffic
// into first-class objects. The `desire.promote` job assembles high-traffic
// adjacent edges into ordered chains (corridors) and files the ones worn past a
// threshold here, each with a human slug and a clerk-authored name. `edgeSig` is
// the canonical node-sequence identity (join of nodeIds), so re-promoting the
// same corridor upserts rather than duplicates. `strength` is the chain's
// decayed traffic at last promotion (a chain is only as worn as its weakest
// link -- min edge value); `lifetime` is the monotonic min traversal count.
// `retiredAt` hides a route that has decayed below the floor without deleting it
// (the archive never deletes) -- an overgrown path, still on file.
export const desirePaths = pgTable(
  'desire_paths',
  {
    id: serial('id').primaryKey(),
    slug: text('slug').notNull().unique(),
    edgeSig: text('edge_sig').notNull().unique(),
    nodeIds: jsonb('node_ids').$type<number[]>().notNull(),
    caption: text('caption'),
    provider: text('provider'),
    model: text('model'),
    strength: real('strength').notNull().default(0),
    lifetime: real('lifetime').notNull().default(0),
    lastWalkedAt: timestamp('last_walked_at', { withTimezone: true }),
    promotedAt: timestamp('promoted_at', { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp('retired_at', { withTimezone: true })
  },
  (t) => ({
    strengthIdx: index('desire_paths_strength_idx').on(t.strength),
    retiredIdx: index('desire_paths_retired_idx').on(t.retiredAt)
  })
);

// ----------------------------------------------------------------------------
// Universe (Phase U1): event-sourced canon + projections
// ----------------------------------------------------------------------------
//
// The institution from /about, made to do its job. `events` is the single
// append-only source of truth: rows are only ever inserted, never updated or
// deleted (never-delete is both the fiction and the architecture). Everything
// below `events` is a projection -- a derived cache that is fully rebuildable
// by replaying the log in id order (see scripts/universe-rebuild.ts). The
// reducers live in src/lib/universe/reduce.ts.
//
// Idempotency rests entirely on `dedupe_key`: the bootstrap script refuses to
// file an event whose key already exists, so re-running it adds nothing.

// Append-only canon. `payload` carries the event-type-specific body (including
// the dossier text and -- for specimen.intake -- the caption embedding vector,
// so a rebuild can re-populate the embeddings table without any API calls).
// `citations` is the list of sources the authoring clerk cited.
export const events = pgTable(
  'events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    type: text('type').notNull(), // 'clerk.commissioned' | 'district.intake' | 'specimen.intake' | 'cross_reference.filed' | (Phase 2: 'dossier.amendment' | 'audit.flagged' | ...)
    subjectType: text('subject_type').notNull(), // 'clerk' | 'district' | 'specimen' | 'cross_reference'
    subjectId: text('subject_id').notNull(), // stable string id of the subject (image id, district key, clerk slug, ...)
    authorClerk: text('author_clerk'), // clerk slug who authored; null for system/seed events
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    citations: jsonb('citations').$type<unknown[]>().notNull().default([]),
    dedupeKey: text('dedupe_key'), // idempotency guard, e.g. 'specimen.intake:<imageId>'
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    subjectIdx: index('events_subject_idx').on(t.subjectType, t.subjectId),
    typeIdx: index('events_type_idx').on(t.type),
    dedupeUniq: uniqueIndex('events_dedupe_key_uniq').on(t.dedupeKey)
  })
);

// PROJECTION. The clerk roster. Seeded as data via clerk.commissioned events
// (so it is rebuildable from the log). Voice + agenda are injected into the
// generation prompt at write time; nothing about a clerk is hardcoded in app
// logic. Agendas are written to conflict, so different clerks disagree.
export const clerks = pgTable('clerks', {
  slug: text('slug').primaryKey(),
  name: text('name').notNull(),
  department: text('department').notNull(),
  voice: text('voice').notNull(),
  agenda: text('agenda').notNull(),
  commissionedAt: timestamp('commissioned_at', { withTimezone: true }).notNull().defaultNow()
});

// PROJECTION. Districts derived from the caption-embedding geometry (community
// detection over the kNN graph). `character` is synthesized from the captions
// nearest the cluster. `memberImageIds` records membership at intake; the
// district a specimen was filed under is immutable.
export const districts = pgTable('districts', {
  key: text('key').primaryKey(), // stable cluster key, e.g. 'district-3'
  name: text('name').notNull(),
  character: text('character').notNull(),
  size: integer('size').notNull().default(0),
  memberImageIds: jsonb('member_image_ids').$type<number[]>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// PROJECTION. One specimen per image. `currentDossier` is the latest case-file
// text; `districtKey` is the district-at-intake (immutable). `generation`
// increments as Phase 2 amendments land. Read by the detail page; never
// reconstructed by replaying the log at request time.
export const specimens = pgTable('specimens', {
  imageId: integer('image_id')
    .primaryKey()
    .references(() => images.id, { onDelete: 'cascade' }),
  clerkSlug: text('clerk_slug').notNull(),
  districtKey: text('district_key').notNull(),
  currentDossier: text('current_dossier').notNull(),
  citations: jsonb('citations').$type<unknown[]>().notNull().default([]),
  intakeEventId: bigint('intake_event_id', { mode: 'number' }).notNull(),
  generation: integer('generation').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// PROJECTION. Directed cross-references between specimens, materialized from
// cross_reference.filed events (which were derived from the image kNN graph at
// intake). Distinct from knn_edges: this is the canon's record of which
// specimens the archive has formally linked.
export const crossReferences = pgTable(
  'cross_references',
  {
    id: serial('id').primaryKey(),
    srcImageId: integer('src_image_id')
      .notNull()
      .references(() => images.id, { onDelete: 'cascade' }),
    dstImageId: integer('dst_image_id')
      .notNull()
      .references(() => images.id, { onDelete: 'cascade' }),
    dist: real('dist'),
    kind: text('kind').notNull().default('knn'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    srcIdx: index('cross_references_src_idx').on(t.srcImageId),
    srcDstKindUniq: uniqueIndex('cross_references_src_dst_kind_uniq').on(
      t.srcImageId,
      t.dstImageId,
      t.kind
    )
  })
);

// PROJECTION. The individual signed fragments that make up dossiers. One row
// per filed fragment (Phase 1 files one 'intake' fragment per specimen; Phase
// 2 amendments append more, never replacing). Each fragment is embedded (a
// matching embeddings row with subject_type='lore') and carries coords
// inherited from its parent image's latest UMAP/manifold projection.
export const loreFragments = pgTable(
  'lore_fragments',
  {
    id: serial('id').primaryKey(),
    specimenImageId: integer('specimen_image_id')
      .notNull()
      .references(() => images.id, { onDelete: 'cascade' }),
    eventId: bigint('event_id', { mode: 'number' }).notNull(),
    clerkSlug: text('clerk_slug').notNull(),
    kind: text('kind').notNull().default('intake'), // 'intake' | 'amendment'
    body: text('body').notNull(),
    sources: jsonb('sources').$type<unknown[]>().notNull().default([]),
    x: real('x'),
    y: real('y'),
    z: real('z'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    specimenIdx: index('lore_fragments_specimen_idx').on(t.specimenImageId, t.createdAt),
    eventUniq: uniqueIndex('lore_fragments_event_uniq').on(t.eventId)
  })
);

// ----------------------------------------------------------------------------
// Universe (Phase U3): recurring characters ("persons of interest")
// ----------------------------------------------------------------------------
//
// A detected figure cropped from an image, with a vision-LLM description and
// its 1536-d text embedding (same space as captions/lore). This is EVIDENCE /
// working data, produced by the characters.detect job -- NOT a projection. The
// canonical interpretation (which crops are the same character) is decided by
// the clustering census and lives in the projection tables below.
export const characterCrops = pgTable(
  'character_crops',
  {
    id: serial('id').primaryKey(),
    imageId: integer('image_id')
      .notNull()
      .references(() => images.id, { onDelete: 'cascade' }),
    label: text('label').notNull(), // the model's short per-image label
    description: text('description').notNull(), // rich visual description (embedded)
    box: jsonb('box').$type<{ left: number; top: number; width: number; height: number }>().notNull(),
    blobUrl: text('blob_url').notNull(),
    blobKey: text('blob_key').notNull(),
    vec: vector('vec', { dimensions: 1536 }).notNull(), // text-description embedding
    // Visual identity embedding of the cropped pixels (Voyage multimodal-3.5,
    // 1024-d). Nullable: crops predate this column / no VOYAGE key at detect
    // time -> backfill with scripts/backfill-crop-visuals.ts. Clustering can run
    // on the text vec, this visual vec, or a blend (see character_tuning.space).
    vecImage: vector('vec_image', { dimensions: 1024 }),
    imageProvider: text('image_provider'),
    imageModel: text('image_model'),
    provider: text('provider'),
    model: text('model'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    imageIdx: index('character_crops_image_idx').on(t.imageId)
  })
);

// PROJECTION. One row per recurring character, materialized from the latest
// character.census event (newest census wins). Identity is interpretation:
// re-clustering supersedes via a new census, never by mutating canon facts.
export const characters = pgTable('characters', {
  key: text('key').primaryKey(), // stable per-census slot, e.g. 'character-3'
  name: text('name').notNull(),
  dossier: text('dossier').notNull(),
  clerkSlug: text('clerk_slug').notNull(),
  canonicalCropUrl: text('canonical_crop_url'),
  appearanceCount: integer('appearance_count').notNull().default(0),
  censusEventId: bigint('census_event_id', { mode: 'number' }).notNull(),
  generation: integer('generation').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// PROJECTION. The character<->specimen cross-references: which images each
// character appears in, with the per-image crop. Materialized from the census.
export const characterAppearances = pgTable(
  'character_appearances',
  {
    id: serial('id').primaryKey(),
    characterKey: text('character_key').notNull(),
    imageId: integer('image_id')
      .notNull()
      .references(() => images.id, { onDelete: 'cascade' }),
    cropUrl: text('crop_url'),
    box: jsonb('box').$type<{ left: number; top: number; width: number; height: number } | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    characterIdx: index('character_appearances_character_idx').on(t.characterKey),
    imageIdx: index('character_appearances_image_idx').on(t.imageId),
    charImageUniq: uniqueIndex('character_appearances_char_image_uniq').on(t.characterKey, t.imageId)
  })
);

// STAGING / working data for the clustering pipeline. characters.cluster writes
// one row per candidate community (vector-clustered crop ids) under a runStamp;
// characters.verify fills verifiedGroups with the mosaic-confirmed subgroups
// (each an array of crop ids that are genuinely the SAME individual -- a single
// candidate can split into several); characters.census reads them, files the
// census, and clears the run. Not a projection -- regenerable, cleared per run.
export const characterCandidates = pgTable(
  'character_candidates',
  {
    id: serial('id').primaryKey(),
    runStamp: bigint('run_stamp', { mode: 'number' }).notNull(),
    candidateIndex: integer('candidate_index').notNull(),
    cropIds: integer('crop_ids').array().notNull(),
    // null until verified; then an array of crop-id groups, each a confirmed
    // same-individual subject. A verify failure leaves it null (census falls
    // back to treating the whole candidate as one group).
    verifiedGroups: jsonb('verified_groups').$type<number[][] | null>(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    runIdx: index('character_candidates_run_idx').on(t.runStamp),
    runCandUniq: uniqueIndex('character_candidates_run_cand_uniq').on(t.runStamp, t.candidateIndex)
  })
);

// Singleton config (id = 1) for the clustering knobs, so the admin sliders'
// last-used values persist as defaults across runs. maxDist is the cosine-
// distance cutoff (lower = tighter/more precise); verifyEnabled toggles the
// mosaic LLM verification pass.
export const characterTuning = pgTable('character_tuning', {
  id: integer('id').primaryKey().default(1),
  maxDist: real('max_dist').notNull().default(0.45),
  k: integer('k').notNull().default(5),
  pruneK: integer('prune_k').notNull().default(4),
  minAppearances: integer('min_appearances').notNull().default(2),
  verifyEnabled: boolean('verify_enabled').notNull().default(true),
  // Which embedding space clustering runs on: 'text' (description vec, the
  // original), 'visual' (Voyage multimodal pixel vec), or 'blend' (both, mixed
  // by blendWeight = the visual share, 0..1). Default stays 'text' so behaviour
  // is unchanged until the crops carry visual vectors + an admin opts in.
  space: text('space').notNull().default('text'),
  blendWeight: real('blend_weight').notNull().default(0.5),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// Eval ground truth. An admin marks each materialized appearance correct/wrong;
// keyed to a stable subjectLabel (not the volatile character-N key) so labels
// survive re-clustering. verdict true = image genuinely depicts the subject.
// scripts/eval-characters.ts scores a census against these.
export const characterLabels = pgTable(
  'character_labels',
  {
    id: serial('id').primaryKey(),
    subjectLabel: text('subject_label').notNull(),
    imageId: integer('image_id')
      .notNull()
      .references(() => images.id, { onDelete: 'cascade' }),
    verdict: boolean('verdict').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    subjectIdx: index('character_labels_subject_idx').on(t.subjectLabel),
    subjectImageUniq: uniqueIndex('character_labels_subject_image_uniq').on(t.subjectLabel, t.imageId)
  })
);

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  images: many(images),
  apiKeys: many(apiKeys),
  providerKeys: many(providerKeys),
  savedPrompts: many(savedPrompts),
  aboutFields: many(aboutFields),
  webhooks: many(webhooks)
}));

export const imagesRelations = relations(images, ({ many, one }) => ({
  owner: one(users, { fields: [images.ownerId], references: [users.id] }),
  captions: many(captions),
  descriptions: many(descriptions),
  tags: many(tags),
  embeddings: many(embeddings),
  reactions: many(reactions),
  comments: many(comments)
}));

export const embeddingsRelations = relations(embeddings, ({ one }) => ({
  image: one(images, { fields: [embeddings.imageId], references: [images.id] })
}));

export const captionsRelations = relations(captions, ({ one }) => ({
  image: one(images, { fields: [captions.imageId], references: [images.id] })
}));

export const descriptionsRelations = relations(descriptions, ({ one }) => ({
  image: one(images, { fields: [descriptions.imageId], references: [images.id] })
}));

export const tagsRelations = relations(tags, ({ one }) => ({
  image: one(images, { fields: [tags.imageId], references: [images.id] })
}));

export const reactionsRelations = relations(reactions, ({ one }) => ({
  image: one(images, { fields: [reactions.imageId], references: [images.id] })
}));

export const commentsRelations = relations(comments, ({ one }) => ({
  image: one(images, { fields: [comments.imageId], references: [images.id] }),
  user: one(users, { fields: [comments.userId], references: [users.id] })
}));

export const collectionsRelations = relations(collections, ({ many }) => ({
  items: many(collectionItems)
}));

export const collectionItemsRelations = relations(collectionItems, ({ one }) => ({
  collection: one(collections, {
    fields: [collectionItems.collectionId],
    references: [collections.id]
  }),
  image: one(images, { fields: [collectionItems.imageId], references: [images.id] })
}));

// Convenience type exports
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Image = typeof images.$inferSelect;
export type NewImage = typeof images.$inferInsert;
export type Caption = typeof captions.$inferSelect;
export type Description = typeof descriptions.$inferSelect;
export type Tag = typeof tags.$inferSelect;
export type Prompt = typeof prompts.$inferSelect;
export type TaxonomyEntry = typeof tagTaxonomy.$inferSelect;
export type Embedding = typeof embeddings.$inferSelect;
export type NewEmbedding = typeof embeddings.$inferInsert;
export type Reaction = typeof reactions.$inferSelect;
export type Comment = typeof comments.$inferSelect;
export type Report = typeof reports.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type ProviderKey = typeof providerKeys.$inferSelect;
export type NewProviderKey = typeof providerKeys.$inferInsert;
export type AiConfig = typeof aiConfig.$inferSelect;
export type NewAiConfig = typeof aiConfig.$inferInsert;
export type FishConfig = typeof fishConfig.$inferSelect;
export type NewFishConfig = typeof fishConfig.$inferInsert;
export type Webhook = typeof webhooks.$inferSelect;
export type NewWebhook = typeof webhooks.$inferInsert;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type NewWebhookDelivery = typeof webhookDeliveries.$inferInsert;
export type Job = typeof jobs.$inferSelect;
// Gate-0 contract feature types
export type CollectionTemperature = typeof collectionTemperature.$inferSelect;
export type ManifoldProjection = typeof manifoldProjections.$inferSelect;
export type KnnEdge = typeof knnEdges.$inferSelect;
export type ImageAttention = typeof imageAttention.$inferSelect;
export type PathTraffic = typeof pathTraffic.$inferSelect;
export type NewPathTraffic = typeof pathTraffic.$inferInsert;
export type DesirePath = typeof desirePaths.$inferSelect;
export type NewDesirePath = typeof desirePaths.$inferInsert;
export type NewJob = typeof jobs.$inferInsert;
export type UmapProjection = typeof umapProjections.$inferSelect;
export type NewUmapProjection = typeof umapProjections.$inferInsert;
export type SavedPrompt = typeof savedPrompts.$inferSelect;
export type NewSavedPrompt = typeof savedPrompts.$inferInsert;
export type AboutField = typeof aboutFields.$inferSelect;
export type NewAboutField = typeof aboutFields.$inferInsert;
export type GalleryConfig = typeof galleryConfig.$inferSelect;
export type NewGalleryConfig = typeof galleryConfig.$inferInsert;
export type Collection = typeof collections.$inferSelect;
export type NewCollection = typeof collections.$inferInsert;
export type CollectionItem = typeof collectionItems.$inferSelect;
export type NewCollectionItem = typeof collectionItems.$inferInsert;
export type GrammarSlot = typeof grammarSlots.$inferSelect;
export type NewGrammarSlot = typeof grammarSlots.$inferInsert;
export type GrammarFiller = typeof grammarFillers.$inferSelect;
export type NewGrammarFiller = typeof grammarFillers.$inferInsert;
export type ConstraintCard = typeof constraintCards.$inferSelect;
export type NewConstraintCard = typeof constraintCards.$inferInsert;
export type VibeAxis = typeof vibeAxes.$inferSelect;
export type NewVibeAxis = typeof vibeAxes.$inferInsert;
export type RemixIdiom = typeof remixIdioms.$inferSelect;
export type NewRemixIdiom = typeof remixIdioms.$inferInsert;
export type ImageLineageEdge = typeof imageLineage.$inferSelect;
export type NewImageLineageEdge = typeof imageLineage.$inferInsert;
// Universe (Phase U1) types
export type UniverseEvent = typeof events.$inferSelect;
export type NewUniverseEvent = typeof events.$inferInsert;
export type Clerk = typeof clerks.$inferSelect;
export type NewClerk = typeof clerks.$inferInsert;
export type District = typeof districts.$inferSelect;
export type NewDistrict = typeof districts.$inferInsert;
export type Specimen = typeof specimens.$inferSelect;
export type NewSpecimen = typeof specimens.$inferInsert;
export type CrossReference = typeof crossReferences.$inferSelect;
export type NewCrossReference = typeof crossReferences.$inferInsert;
export type LoreFragment = typeof loreFragments.$inferSelect;
export type NewLoreFragment = typeof loreFragments.$inferInsert;
// Universe (Phase U3) character types
export type CharacterCrop = typeof characterCrops.$inferSelect;
export type NewCharacterCrop = typeof characterCrops.$inferInsert;
export type Character = typeof characters.$inferSelect;
export type NewCharacter = typeof characters.$inferInsert;
export type CharacterAppearance = typeof characterAppearances.$inferSelect;
export type NewCharacterAppearance = typeof characterAppearances.$inferInsert;
export type CharacterCandidate = typeof characterCandidates.$inferSelect;
export type NewCharacterCandidate = typeof characterCandidates.$inferInsert;
export type CharacterTuning = typeof characterTuning.$inferSelect;
export type NewCharacterTuning = typeof characterTuning.$inferInsert;
export type CharacterLabel = typeof characterLabels.$inferSelect;
export type NewCharacterLabel = typeof characterLabels.$inferInsert;

// Taste (cycle: taste-vector). Each round of the /taste this-or-that is a
// pairwise vote -- the picked image beat the passed-over one. Aggregated, these
// become a crowd "most magnetic" ranking. Raw votes (not a running Elo) keep
// writes append-only and race-free; the leaderboard aggregates on read.
export const tasteVotes = pgTable(
  'taste_votes',
  {
    id: serial('id').primaryKey(),
    winnerId: integer('winner_id')
      .notNull()
      .references(() => images.id, { onDelete: 'cascade' }),
    loserId: integer('loser_id')
      .notNull()
      .references(() => images.id, { onDelete: 'cascade' }),
    ipHash: text('ip_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    winnerIdx: index('taste_votes_winner_idx').on(t.winnerId),
    loserIdx: index('taste_votes_loser_idx').on(t.loserId),
    // A vote is always between two distinct images. Enforce it at the DB so a
    // bad row can't slip in even if some future writer bypasses the route guard.
    distinct: check('taste_votes_distinct', sql`winner_id <> loser_id`)
  })
);

export type TasteVote = typeof tasteVotes.$inferSelect;
export type NewTasteVote = typeof tasteVotes.$inferInsert;
