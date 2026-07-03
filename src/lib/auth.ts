import NextAuth, { type DefaultSession, type NextAuthConfig } from 'next-auth';
import type { Provider } from 'next-auth/providers';
import GitHub from 'next-auth/providers/github';
import Google from 'next-auth/providers/google';
import Apple from 'next-auth/providers/apple';
import Credentials from 'next-auth/providers/credentials';
import { getEmailUserByEmail, getUserById, getUserByHandle, upsertUser } from './db/queries/users';
import { rateLimit } from './rate-limit';
// NOTE: `./password` and `./hash` (both pull in node:crypto) are intentionally
// NOT imported at module scope. `middleware.ts` imports `auth` from this file
// and runs in the Edge runtime, so anything in this module's static graph ships
// to Edge. Those two are dynamically imported inside `authorize` (a Node-only
// route) so node:crypto never reaches the middleware bundle. `./rate-limit` is
// pure JS (no node:crypto) and is safe to import statically.

declare module 'next-auth' {
  interface Session {
    user: {
      // Provider-scoped stable id. GitHub keeps its bare numeric id; other
      // providers are namespaced (`google:<sub>`, `apple:<sub>`,
      // `email:<lowercased-email>`) so identities can never collide.
      // Phase F replaces every `isOwner` gate with `canEdit(session, ownerId)`
      // checked against this value.
      id?: string;
      handle?: string;
      role?: 'user' | 'admin';
      // Legacy alias kept while phase F migrates callers off it. Only set for
      // GitHub identities (it mirrors OWNER_GITHUB_ID for the bootstrap admin).
      githubId?: string;
    } & DefaultSession['user'];
  }
}

// A provider-agnostic view of who just signed in, built from the OAuth
// profile/account or the credentials user before we touch the DB.
type Identity = {
  id: string;
  provider: string;
  // Seed for the URL handle when the user has no row yet.
  handleSeed: string;
  displayName: string | null;
  email: string | null;
  avatarUrl: string | null;
};

// Slugify a login/email/name into a URL-safe handle, then resolve collisions
// against the users table by suffixing -2, -3, ... Returns the existing
// handle for the same id (so re-login doesn't churn).
async function resolveHandle(seed: string, ownId: string): Promise<string> {
  const base =
    seed
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
  return `${base}-${ownId.slice(0, 8).replace(/[^a-z0-9-]/g, '')}`;
}

// Local-part of an email, used as a handle seed for providers that don't
// carry a login (Google/Apple/email).
function emailLocalPart(email: string | null | undefined): string {
  return (email ?? '').split('@')[0] || 'user';
}

// Postgres unique-constraint violation (SQLSTATE 23505). Plain error-code check
// -- no node:crypto -- so it stays safe in this Edge-reachable module.
function isUniqueViolation(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}

// Build the normalized identity from whichever sign-in shape we got. Returns
// null for a provider/profile combo we don't recognize (sign-in then proceeds
// on the token as-is).
function toIdentity(
  provider: string | undefined,
  profile: Record<string, unknown> | undefined,
  user: { id?: string | null; email?: string | null; name?: string | null } | undefined
): Identity | null {
  if (provider === 'github' && profile && profile.id != null) {
    const id = String(profile.id);
    return {
      id,
      provider: 'github',
      handleSeed: (profile.login as string) || id,
      displayName: (profile.name as string) ?? null,
      email: (profile.email as string) ?? null,
      avatarUrl: (profile.avatar_url as string) ?? null
    };
  }
  if (provider === 'google' && profile && profile.sub != null) {
    const email = (profile.email as string) ?? null;
    return {
      id: `google:${String(profile.sub)}`,
      provider: 'google',
      // emailLocalPart already falls back to 'user' when the email is absent.
      handleSeed: emailLocalPart(email),
      displayName: (profile.name as string) ?? null,
      email,
      avatarUrl: (profile.picture as string) ?? null
    };
  }
  if (provider === 'apple' && profile && profile.sub != null) {
    // Apple only returns name/email on the *first* authorization; subsequent
    // sign-ins carry just `sub`. The stored row keeps the first values.
    const email = (profile.email as string) ?? null;
    return {
      id: `apple:${String(profile.sub)}`,
      provider: 'apple',
      handleSeed: emailLocalPart(email),
      displayName: (profile.name as string) ?? null,
      email,
      avatarUrl: null
    };
  }
  if (provider === 'credentials' && user && user.id) {
    // authorize() already resolved this to a real users row.
    return {
      id: user.id,
      provider: 'email',
      handleSeed: emailLocalPart(user.email),
      displayName: user.name ?? null,
      email: user.email ?? null,
      avatarUrl: null
    };
  }
  return null;
}

// Providers are conditional: a GitHub-only deployment stays working when the
// Google/Apple env vars are unset, and email/password is always available.
// Auth.js also auto-reads AUTH_<PROVIDER>_ID/SECRET, but we pass explicitly so
// the presence check is unambiguous.
function buildProviders(): Provider[] {
  const providers: Provider[] = [
    GitHub({
      clientId: process.env.AUTH_GITHUB_ID,
      clientSecret: process.env.AUTH_GITHUB_SECRET
    })
  ];

  if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) {
    providers.push(
      Google({
        clientId: process.env.AUTH_GOOGLE_ID,
        clientSecret: process.env.AUTH_GOOGLE_SECRET
      })
    );
  }

  if (process.env.AUTH_APPLE_ID && process.env.AUTH_APPLE_SECRET) {
    providers.push(
      Apple({
        clientId: process.env.AUTH_APPLE_ID,
        clientSecret: process.env.AUTH_APPLE_SECRET
      })
    );
  }

  providers.push(
    Credentials({
      // The custom /signin page drives this; the fields are here so Auth.js's
      // default form still works as a fallback.
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' }
      },
      async authorize(raw, request) {
        const email = typeof raw?.email === 'string' ? raw.email.trim().toLowerCase() : '';
        const password = typeof raw?.password === 'string' ? raw.password : '';
        if (!email || !password) return null;

        // Throttle BEFORE the DB read + scrypt verify to blunt credential
        // stuffing and the per-attempt CPU cost. Sliding windows keyed per
        // account and per client IP (same in-memory helper as the public write
        // endpoints). `./hash` (node:crypto) and `./password` are dynamically
        // imported so neither reaches the Edge middleware bundle (see the note
        // at the top of this file). A throttled attempt returns null -- the user
        // sees the same "invalid credentials" as a wrong password.
        const { getRequestIp, hashIp } = await import('./hash');
        const ip = request instanceof Request ? getRequestIp(request) : 'unknown';
        const withinLimit =
          rateLimit(`login:email:${email}`, 10, 10 * 60_000) &&
          rateLimit(`login:ip:${hashIp(ip)}`, 30, 10 * 60_000);
        if (!withinLimit) return null;

        const existing = await getEmailUserByEmail(email);
        if (!existing) return null;
        const { verifyPassword } = await import('./password');
        if (!verifyPassword(password, existing.passwordHash)) return null;
        return {
          id: existing.id,
          email: existing.email,
          name: existing.displayName
        };
      }
    })
  );

  return providers;
}

const config: NextAuthConfig = {
  providers: buildProviders(),
  session: { strategy: 'jwt' },
  pages: { signIn: '/signin' },
  callbacks: {
    async jwt({ token, account, profile, user }) {
      // Only enrich the token on initial sign-in (when `account` is present).
      // Subsequent requests reuse the token without an extra DB hit.
      if (!account) return token;
      const identity = toIdentity(
        account.provider,
        profile as Record<string, unknown> | undefined,
        user as { id?: string | null; email?: string | null; name?: string | null } | undefined
      );
      if (!identity) return token;

      const t = token as Record<string, unknown>;
      t.id = identity.id;
      // The legacy githubId alias only makes sense for the GitHub identity.
      if (identity.provider === 'github') t.githubId = identity.id;
      // Stamp role deterministically BEFORE the DB upsert so a transient
      // DB failure during bootstrap-admin sign-in doesn't lock them out
      // of admin-gated routes. The DB result (when available) always
      // wins on the next sign-in. Only the GitHub OWNER_GITHUB_ID bootstraps
      // admin; other providers start as 'user'.
      const fallbackRole: 'user' | 'admin' =
        identity.provider === 'github' && identity.id === process.env.OWNER_GITHUB_ID
          ? 'admin'
          : 'user';
      t.role = fallbackRole;

      try {
        const existing = await getUserById(identity.id);
        const role: 'user' | 'admin' = existing?.role === 'admin' ? 'admin' : fallbackRole;
        // Existing users keep their handle; a new user resolves a fresh one.
        // Two new users whose seeds slugify the same can resolve the same free
        // handle concurrently, so the loser hits users.handle unique (23505) in
        // the insert. Retry with a re-resolved handle (mirrors /api/register) so
        // we never mint a session with no user row -- which would fail the
        // images.ownerId FK on the next upload.
        let handle = existing?.handle ?? null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (!handle) handle = await resolveHandle(identity.handleSeed, identity.id);
          try {
            await upsertUser({
              id: identity.id,
              handle,
              // Apple (and any provider) may omit name/email/avatar on sign-ins
              // after the first, sending null. Fall back to the stored values so
              // a later login doesn't wipe the profile captured on first sign-in.
              displayName: identity.displayName ?? existing?.displayName ?? null,
              email: identity.email ?? existing?.email ?? null,
              avatarUrl: identity.avatarUrl ?? existing?.avatarUrl ?? null,
              provider: identity.provider,
              role
            });
            t.handle = handle;
            t.role = role;
            break;
          } catch (err) {
            if (!isUniqueViolation(err)) throw err; // real failure -> outer catch
            handle = null; // handle race -- re-resolve on the next iteration
          }
        }
      } catch (err) {
        // Sign-in proceeds with the deterministic role + no handle. The
        // next successful sign-in repairs the JWT once the DB recovers.
        console.error('auth: user upsert failed; using fallback role', err);
      }
      return token;
    },
    async session({ session, token }) {
      const t = token as Record<string, unknown>;
      const id = typeof t.id === 'string' ? t.id : undefined;
      const githubId = typeof t.githubId === 'string' ? t.githubId : undefined;
      const handle = typeof t.handle === 'string' ? t.handle : undefined;
      const role: 'user' | 'admin' = t.role === 'admin' ? 'admin' : 'user';
      if (id) session.user.id = id;
      if (githubId) session.user.githubId = githubId;
      if (handle) session.user.handle = handle;
      session.user.role = role;
      return session;
    }
  }
};

export const {
  auth,
  handlers: { GET, POST },
  signIn,
  signOut
} = NextAuth(config);

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
