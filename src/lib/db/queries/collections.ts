import { and, desc, eq, inArray, sql } from 'drizzle-orm';
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
import {
  isValidCollectionSlug,
  mintCollectionSlug,
  mintCollectionSlugFallback
} from '../../collections/slug';

// Shape returned to callers/clients. Strips ownerHash and fingerprint
// so neither the share URL nor the public read API leaks the visitor's
// IP-derived identifier. ownerHash is hashed but it's still a stable
// per-visitor fingerprint that should stay server-only.
export type PublicCollection = {
  id: number;
  slug: string;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export function toPublicCollection(c: Collection): PublicCollection {
  return {
    id: c.id,
    slug: c.slug,
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt
  };
}

export type CollectionWithItems = PublicCollection & {
  items: ImageWithRelations[];
};

// Bumped from 5; with the new 6-hex tail the pool is ~135B, so even 25
// retries is virtually impossible to exhaust until the table has
// astronomical rows.
const SLUG_RETRIES = 25;

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
  // Fallback: longer hex tail. Stays inside the same SLUG_RE so the
  // inserted row is still resolvable through getCollectionBySlug.
  const fallback = mintCollectionSlugFallback();
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
// Returns the public shape (no ownerHash/fingerprint) since this powers
// the share-link page.
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
  if (itemRows.length === 0) return { ...toPublicCollection(col), items: [] };
  const ids = itemRows.map((r) => r.imageId);
  // inArray is the right tool here -- the previous hand-built `IN (...)`
  // template was easy to misread as unbalanced and harder to maintain.
  const imageRows = await db.select().from(images).where(inArray(images.id, ids));
  const orderMap = new Map(ids.map((id, i) => [id, i] as const));
  imageRows.sort((a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0));
  const hydrated = await hydrateImages(imageRows);
  return { ...toPublicCollection(col), items: hydrated };
}

// Read the visitor's default shelf without creating one. Used by
// DELETE flows so an unsave attempt by a first-time visitor doesn't
// insert an empty shelf as a side effect.
export async function findDefaultShelf(params: {
  ownerHash: string;
  fingerprint: string | null;
}): Promise<Collection | null> {
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
  return existing ?? null;
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
  const existing = await findDefaultShelf(params);
  if (existing) return { collection: existing, created: false };
  const created = await createCollection({
    ownerHash: params.ownerHash,
    fingerprint: params.fingerprint
  });
  return { collection: created, created: true };
}

// Owner-check helper used by mutating routes. For signed-in users the
// ownerHash itself is sufficient (it's their user.id, which the
// session proves). For anonymous shelves the (ip_hash, fingerprint)
// pair is the identity, so we also require the inbound fingerprint to
// match the stored one. A null stored fingerprint -- legacy or
// pre-migration row -- falls back to ownerHash-only behavior.
export function isShelfOwner(
  collection: Pick<Collection, 'ownerHash' | 'fingerprint'>,
  requesterHash: string,
  isSignedIn: boolean,
  requesterFingerprint: string | null
): boolean {
  if (collection.ownerHash !== requesterHash) return false;
  if (isSignedIn) return true;
  if (!collection.fingerprint) return true;
  return !!requesterFingerprint && requesterFingerprint === collection.fingerprint;
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
