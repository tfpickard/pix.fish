import { relations } from 'drizzle-orm';
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
export const reports = pgTable('reports', {
  id: serial('id').primaryKey(),
  targetType: text('target_type').notNull(), // 'image' | 'comment'
  targetId: integer('target_id').notNull(),
  reason: text('reason'),
  ipHash: text('ip_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// ----------------------------------------------------------------------------
// Phase 4+ tables (not created yet; see SPEC.md "Data model" section)
//   webhooks         -- outbound webhook config
//   jobs             -- async enrichment queue
//   ai_config        -- runtime provider routing
//   saved_prompts    -- hybrid prompt generator output
// ----------------------------------------------------------------------------

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
