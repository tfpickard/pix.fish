import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../client';
import {
  collectionItems,
  collections,
  images,
  type Collection
} from '../schema';
import {
  hydrateImages,
  type ImageWithRelations
} from './images';
import { isValidCollectionSlug, mintCollectionSlug } from '../../collections/slug';

export type CollectionWithItems = Collection & {
  items: ImageWithRelations[];
};

const SLUG_RETRIES = 5;

// Mint a new collection with an unused slug. Retries on the unique-
// constraint collision; falls back to a longer numeric tail after a few
// tries so we don't loop forever in a (theoretical) pathological pool.
export async function createCollection(params: {
  ownerHash: string;
  fingerprint: string | null;
  title?: string | null;
}): Promise<Collection> {
  for (let attempt = 0; attempt < SLUG_RETRIES; attempt++) {
    const slug = mintCollectionSlug();
    try {
      const [row] = await db
        .insert(collections)
        .values({
          slug,
          title: params.title ?? null,
          ownerHash: params.ownerHash,
          fingerprint: params.fingerprint
        })
        .returning();
      return row;
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      // 23505 = unique_violation; any other error is unexpected.
      if (code !== '23505') throw err;
    }
  }
  // Fallback: append a longer suffix so a unique slug is virtually
  // guaranteed even after multiple base-pool collisions.
  const fallback = `${mintCollectionSlug()}-${Math.floor(Math.random() * 1e6)}`;
  const [row] = await db
    .insert(collections)
    .values({
      slug: fallback,
      title: params.title ?? null,
      ownerHash: params.ownerHash,
      fingerprint: params.fingerprint
    })
    .returning();
  return row;
}

// Read a collection by slug. Returns null when the slug shape is invalid
// or the row doesn't exist; callers translate either to a 404.
export async function getCollectionBySlug(
  slug: string
): Promise<Collection | null> {
  if (!isValidCollectionSlug(slug)) return null;
  const [row] = await db.select().from(collections).where(eq(collections.slug, slug));
  return row ?? null;
}

// Hydrate a collection's items as full ImageWithRelations rows ordered
// by addedAt desc, so a freshly-saved image appears first on the shelf.
export async function getCollectionWithItems(
  slug: string
): Promise<CollectionWithItems | null> {
  const col = await getCollectionBySlug(slug);
  if (!col) return null;
  const itemRows = await db
    .select({ imageId: collectionItems.imageId, createdAt: collectionItems.createdAt })
    .from(collectionItems)
    .where(eq(collectionItems.collectionId, col.id))
    .orderBy(desc(collectionItems.createdAt));
  if (itemRows.length === 0) return { ...col, items: [] };
  // Re-fetch image rows in the same order the join returned them.
  const ids = itemRows.map((r) => r.imageId);
  const imageRows = await db
    .select()
    .from(images)
    .where(sql`${images.id} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
  const orderMap = new Map(ids.map((id, i) => [id, i] as const));
  imageRows.sort((a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0));
  const hydrated = await hydrateImages(imageRows);
  return { ...col, items: hydrated };
}

// First-or-create the visitor's default shelf. We key on (ownerHash,
// fingerprint) so two visitors behind a shared NAT each get their own,
// while reloading the same browser keeps adding to the same shelf.
// Returns the resolved collection plus a flag that says "we just made
// this", so callers can include the slug in the response and the client
// can persist it to localStorage.
export async function findOrCreateDefaultShelf(params: {
  ownerHash: string;
  fingerprint: string | null;
}): Promise<{ collection: Collection; created: boolean }> {
  const where = params.fingerprint
    ? and(
        eq(collections.ownerHash, params.ownerHash),
        eq(collections.fingerprint, params.fingerprint)
      )
    : eq(collections.ownerHash, params.ownerHash);
  const [existing] = await db
    .select()
    .from(collections)
    .where(where)
    .orderBy(desc(collections.updatedAt))
    .limit(1);
  if (existing) return { collection: existing, created: false };
  const created = await createCollection({
    ownerHash: params.ownerHash,
    fingerprint: params.fingerprint
  });
  return { collection: created, created: true };
}

// Upsert-style add: returns true if a new row was inserted, false if
// the (collection, image) pair was already present. Either way the
// caller treats the post-state as "image is on the shelf".
export async function addItemToCollection(params: {
  collectionId: number;
  imageId: number;
}): Promise<{ inserted: boolean }> {
  const inserted = await db
    .insert(collectionItems)
    .values({ collectionId: params.collectionId, imageId: params.imageId })
    .onConflictDoNothing({
      target: [collectionItems.collectionId, collectionItems.imageId]
    })
    .returning({ id: collectionItems.id });
  // Touch the parent collection's updatedAt so "default shelf" lookups
  // surface the most recently active one when fingerprint is missing.
  await db
    .update(collections)
    .set({ updatedAt: sql`now()` })
    .where(eq(collections.id, params.collectionId));
  return { inserted: inserted.length > 0 };
}

export async function removeItemFromCollection(params: {
  collectionId: number;
  imageId: number;
}): Promise<{ removed: boolean }> {
  const deleted = await db
    .delete(collectionItems)
    .where(
      and(
        eq(collectionItems.collectionId, params.collectionId),
        eq(collectionItems.imageId, params.imageId)
      )
    )
    .returning({ id: collectionItems.id });
  return { removed: deleted.length > 0 };
}

export async function renameCollection(params: {
  id: number;
  title: string | null;
}): Promise<Collection | null> {
  const [row] = await db
    .update(collections)
    .set({ title: params.title, updatedAt: sql`now()` })
    .where(eq(collections.id, params.id))
    .returning();
  return row ?? null;
}

// Lightweight membership check used by the image-detail page so the
// "save to shelf" button can render in its post-saved state on first
// paint when the visitor is already-saved.
export async function isImageInAnyShelfFor(params: {
  ownerHash: string;
  imageId: number;
}): Promise<boolean> {
  const [row] = await db
    .select({ id: collectionItems.id })
    .from(collectionItems)
    .innerJoin(collections, eq(collections.id, collectionItems.collectionId))
    .where(
      and(
        eq(collections.ownerHash, params.ownerHash),
        eq(collectionItems.imageId, params.imageId)
      )
    )
    .limit(1);
  return !!row;
}
