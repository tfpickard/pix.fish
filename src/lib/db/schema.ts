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

export const images = pgTable(
  'images',
  {
    id: serial('id').primaryKey(),
    slug: text('slug').notNull().unique(),
    slugHistory: text('slug_history').array().notNull().default([]),
    blobUrl: text('blob_url').notNull(),
    blobKey: text('blob_key').notNull(),
    mime: text('mime'),
    width: integer('width'),
    height: integer('height'),
    takenAt: timestamp('taken_at', { withTimezone: true }),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
    ownerId: text('owner_id').notNull(),
    exif: jsonb('exif'),
    palette: text('palette').array(),
    manualCaption: text('manual_caption')
  },
  (t) => ({
    uploadedAtIdx: index('images_uploaded_at_idx').on(t.uploadedAt),
    slugHistoryIdx: index('images_slug_history_idx').using('gin', t.slugHistory)
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

export const apiKeys = pgTable('api_keys', {
  id: serial('id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  label: text('label'),
  keyHash: text('key_hash').notNull().unique(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

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
// real rotation UI.
export const webhooks = pgTable('webhooks', {
  id: serial('id').primaryKey(),
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

// Owner-composed prompt variants. Promoting one overwrites `prompts.template`
// for the matching key and bumps `prompts.version`; `fragments` is preserved
// so the composer can round-trip edits.
export const savedPrompts = pgTable('saved_prompts', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  key: text('key').notNull(), // matches prompts.key
  template: text('template').notNull(),
  fragments: jsonb('fragments'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// Owner-editable fields that power /about. Each row is one named field
// (key = stable slug) with a display label, body text, and sort order.
// Owner can edit content inline or ask the LLM to regenerate per-field.
export const aboutFields = pgTable('about_fields', {
  id: serial('id').primaryKey(),
  key: text('key').notNull().unique(),
  label: text('label').notNull(),
  content: text('content').notNull().default(''),
  sortOrder: integer('sort_order').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// Relations
export const imagesRelations = relations(images, ({ many }) => ({
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

// Convenience type exports
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
