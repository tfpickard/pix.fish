import { and, eq, sql } from 'drizzle-orm';
import { db } from '../client';
import { users, type User, type NewUser } from '../schema';

// The bootstrap site admin's user id is OWNER_GITHUB_ID. Until the auth
// callbacks are wired to upsert users on first sign-in, this is also the
// value of session.user.id for the existing owner. Use this anywhere a
// public-facing view needs "the site admin's" content (about page, default
// gallery config) so we don't lock the lookup to a specific id format.
export function getSiteAdminId(): string {
  const id = process.env.OWNER_GITHUB_ID;
  if (!id) throw new Error('OWNER_GITHUB_ID is required for the site-admin lookup');
  return id;
}

export async function getUserById(id: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}

export async function getUserByHandle(handle: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.handle, handle)).limit(1);
  return row ?? null;
}

// Look up an email/password user by address (case-insensitive). The email id is
// opaque (`email:<uuid>`) and no longer derived from the address, so the
// credentials sign-in and the registration duplicate-check resolve users this
// way. Scoped to provider='email' so it never returns an OAuth row that happens
// to share the address -- those have no password and must not be login targets.
export async function getEmailUserByEmail(email: string): Promise<User | null> {
  const [row] = await db
    .select()
    .from(users)
    .where(and(eq(users.provider, 'email'), sql`lower(${users.email}) = ${email.toLowerCase()}`))
    .limit(1);
  return row ?? null;
}

// Upsert on the natural id (provider-scoped, e.g. GitHub numeric id as text).
// `handle` is required only when inserting; on update we leave the existing
// handle alone so a user can rename without it being clobbered every login.
// Note: passwordHash is intentionally never touched here -- OAuth sign-ins go
// through this path and must not clear an email user's stored password.
export async function upsertUser(input: NewUser): Promise<User> {
  const [row] = await db
    .insert(users)
    .values(input)
    .onConflictDoUpdate({
      target: users.id,
      set: {
        displayName: input.displayName,
        avatarUrl: input.avatarUrl,
        email: input.email,
        updatedAt: new Date()
      }
    })
    .returning();
  if (!row) throw new Error('upsertUser returned no row');
  return row;
}

// Email/password registration. The id is `email:<lowercased-email>`, so a
// second registration with the same address hits the PK and is rejected --
// we return null in that case (caller surfaces "already registered") rather
// than clobbering the existing row. handle collisions are resolved by the
// caller before insert.
export async function createEmailUser(input: NewUser): Promise<User | null> {
  const [row] = await db
    .insert(users)
    .values(input)
    .onConflictDoNothing({ target: users.id })
    .returning();
  return row ?? null;
}
