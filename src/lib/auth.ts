import NextAuth, { type DefaultSession } from 'next-auth';
import GitHub from 'next-auth/providers/github';

declare module 'next-auth' {
  interface Session {
    user: {
      githubId?: string;
    } & DefaultSession['user'];
  }
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
      if (profile && 'id' in profile && profile.id != null) {
        (token as Record<string, unknown>).githubId = String(profile.id);
      }
      return token;
    },
    async session({ session, token }) {
      const githubId = (token as Record<string, unknown>).githubId;
      if (typeof githubId === 'string') {
        session.user.githubId = githubId;
      }
      return session;
    }
  }
});

export function isOwner(session: { user?: { githubId?: string } } | null | undefined): boolean {
  const ownerId = process.env.OWNER_GITHUB_ID;
  if (!ownerId) return false;
  return session?.user?.githubId === ownerId;
}
