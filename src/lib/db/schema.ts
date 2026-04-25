import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  index,
  vector
} from 'drizzle-orm/pg-core';

// ----------------------------------------------------------------------------
// Phase 1 tables
// ----------------------------------------------------------------------------

// Users. One row per signed-in identity. PK is provider-scoped:
// for GitHub it's the numeric `profile.id` as text. `handle` is the
// public, URL-safe identifier used in /u/<handle>/<slug>; collisions get a
// numeric suffix at first sign-in. `role` gates site-admin features:
// the bootstrap user (`OWNER_GITHUB_ID`) is upserted as 'admin' on first run.
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  handle: text('handle').notNull().unique(),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  email: text('email'),
  provider: text('provider').notNull().default('github'),
  role: text('role').notNull().default('user'), // 'user' | 'admin'
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

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
    nsfwSource: text('nsfw_source') // 'auto' | 'manual' | null (legacy rows)
  },
  (t) => ({
    uploadedAtIdx: index('images_uploaded_at_idx').on(t.uploadedAt),
    slugHistoryIdx: index('images_slug_history_idx').using('gin', t.slugHistory),
    // Per-user slug namespace. Two users can both have /u/alice/sunset and
    // /u/bob/sunset; the legacy /<slug> redirect resolves to whichever owner
    // currently holds it (with slug_history covering renames).
    ownerSlugUniq: uniqueIndex('images_owner_slug_uniq').on(t.ownerId, t.slug),
    nsfwIdx: index('images_is_nsfw_idx').on(t.isNsfw)
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

// Embeddings live in pgvector. Phase 2 writes only `kind='caption'` (text
// embedding of the slug-source caption via OpenAI text-embedding-3-small, 1536
// dims). `image` and `combined` kinds are reserved for later phases that add
// CLIP or multimodal models. Unique on (image_id, kind) so reprocessing
// overwrites cleanly via onConflictDoUpdate.
export const embeddings = pgTable(
  'embeddings',
  {
    id: serial('id').primaryKey(),
    imageId: integer('image_id')
      .notNull()
      .references(() => images.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // 'image' | 'caption' | 'combined'
    provider: text('provider'),
    model: text('model'),
    vec: vector('vec', { dimensions: 1536 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    imageKindUniq: uniqueIndex('embeddings_image_kind_uniq').on(t.imageId, t.kind),
    imageIdx: index('embeddings_image_id_idx').on(t.imageId)
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

// Anonymous comments. status flows: pending -> approved | rejected.
// Approved comments are publicly visible; pending ones are hidden until
// the owner approves from the moderation queue.
export const comments = pgTable(
  'comments',
  {
    id: serial('id').primaryKey(),
    imageId: integer('image_id')
      .notNull()
      .references(() => images.id, { onDelete: 'cascade' }),
    authorName: text('author_name'),
    body: text('body').notNull(),
    status: text('status').notNull().default('pending'), // 'pending' | 'approved' | 'rejected'
    ipHash: text('ip_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    imageIdx: index('comments_image_id_idx').on(t.imageId),
    statusIdx: index('comments_status_idx').on(t.status)
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
  image: one(images, { fields: [comments.imageId], references: [images.id] })
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
export type Webhook = typeof webhooks.$inferSelect;
export type NewWebhook = typeof webhooks.$inferInsert;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type NewWebhookDelivery = typeof webhookDeliveries.$inferInsert;
export type Job = typeof jobs.$inferSelect;
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
