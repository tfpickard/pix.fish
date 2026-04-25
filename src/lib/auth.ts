import NextAuth, { type DefaultSession } from 'next-auth';
import GitHub from 'next-auth/providers/github';
import { getUserById, getUserByHandle, upsertUser } from './db/queries/users';

declare module 'next-auth' {
  interface Session {
    user: {
      // Provider-scoped stable id (currently the GitHub numeric id as text).
      // Phase F replaces every `isOwner` gate with `canEdit(session, ownerId)`
      // checked against this value.
      id?: string;
      handle?: string;
      role?: 'user' | 'admin';
      // Legacy alias kept while phase F migrates callers off it.
      githubId?: string;
    } & DefaultSession['user'];
  }
}

// Slugify a GitHub login into a URL-safe handle, then resolve collisions
// against the users table by suffixing -2, -3, ... Returns the existing
// handle for the same id (so re-login doesn't churn).
async function resolveHandle(login: string, ownId: string): Promise<string> {
  const base =
    login
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'user';
  let candidate = base;
  let n = 1;
  // Bounded loop -- if we somehow hit 100 collisions, fall through to a
  // suffix that includes the id to guarantee uniqueness.
  while (n < 100) {
    const existing = await getUserByHandle(candidate);
    if (!existing || existing.id === ownId) return candidate;
    n += 1;
    candidate = `${base}-${n}`;
  }
  return `${base}-${ownId.slice(0, 8)}`;
}

export const {
  auth,
  handlers: { GET, POST },
  signIn,
  signOut
} = NextAuth({
  providers: [
    GitHub({
      clientId: process.env.AUTH_GITHUB_ID,
      clientSecret: process.env.AUTH_GITHUB_SECRET
    })
  ],
  session: { strategy: 'jwt' },
  callbacks: {
    async jwt({ token, profile }) {
      // Only enrich the token on initial sign-in (when profile is present).
      // Subsequent requests reuse the token without an extra DB hit.
      if (profile && 'id' in profile && profile.id != null) {
        const id = String(profile.id);
        const p = profile as {
          login?: string;
          name?: string | null;
          email?: string | null;
          avatar_url?: string | null;
        };
        const t = token as Record<string, unknown>;
        t.id = id;
        t.githubId = id;
        // Stamp role deterministically BEFORE the DB upsert so a transient
        // DB failure during bootstrap-admin sign-in doesn't lock them out
        // of admin-gated routes. The DB result (when available) always
        // wins on the next sign-in.
        const fallbackRole: 'user' | 'admin' =
          id === process.env.OWNER_GITHUB_ID ? 'admin' : 'user';
        t.role = fallbackRole;
        try {
          const existing = await getUserById(id);
          const handle = existing?.handle ?? (await resolveHandle(p.login || id, id));
          const role: 'user' | 'admin' =
            existing?.role === 'admin' ? 'admin' : fallbackRole;
          await upsertUser({
            id,
            handle,
            displayName: p.name ?? null,
            email: p.email ?? null,
            avatarUrl: p.avatar_url ?? null,
            provider: 'github',
            role
          });
          t.handle = handle;
          t.role = role;
        } catch (err) {
          // Sign-in proceeds with the deterministic role + no handle. The
          // next successful sign-in repairs the JWT once the DB recovers.
          console.error('auth: user upsert failed; using fallback role', err);
        }
      }
      return token;
    },
    async session({ session, token }) {
      const t = token as Record<string, unknown>;
      const id = typeof t.id === 'string' ? t.id : undefined;
      const githubId = typeof t.githubId === 'string' ? t.githubId : id;
      const handle = typeof t.handle === 'string' ? t.handle : undefined;
      const role: 'user' | 'admin' = t.role === 'admin' ? 'admin' : 'user';
      if (id) session.user.id = id;
      if (githubId) session.user.githubId = githubId;
      if (handle) session.user.handle = handle;
      session.user.role = role;
      return session;
    }
  }
});

// Legacy predicate -- still gates every admin route. Phase F replaces
// each call site with isSiteAdmin (for platform actions) or canEdit (for
// per-resource ownership) and this can be deleted then.
export function isOwner(session: { user?: { githubId?: string } } | null | undefined): boolean {
  const ownerId = process.env.OWNER_GITHUB_ID;
  if (!ownerId) return false;
  return session?.user?.githubId === ownerId;
}

// Site-admin gate. Sources of truth: users.role (set by the seed for the
// bootstrap user, only flippable via direct DB edit). Compared to isOwner,
// this no longer requires OWNER_GITHUB_ID at runtime once the role column
// is populated.
export function isSiteAdmin(
  session: { user?: { role?: string } } | null | undefined
): boolean {
  return session?.user?.role === 'admin';
}

// Per-resource owner gate. Site admins always pass so they can moderate
// or rescue any user's content.
export function canEdit(
  session: { user?: { id?: string; role?: string } } | null | undefined,
  resourceOwnerId: string | null | undefined
): boolean {
  if (!session?.user) return false;
  if (session.user.role === 'admin') return true;
  return !!resourceOwnerId && session.user.id === resourceOwnerId;
}
