import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { SignInForm } from '@/components/sign-in-form';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'sign in'
};

// Custom auth surface (Auth.js `pages.signIn` points here). Which OAuth
// buttons render depends on which providers are configured via env, computed
// server-side so an unconfigured provider never shows a dead button.
export default async function SignInPage({
  searchParams
}: {
  searchParams: { callbackUrl?: string; error?: string };
}) {
  const session = await auth();
  const rawCallback = searchParams.callbackUrl;
  // Only allow same-origin relative callbacks to avoid an open-redirect. Must
  // start with a single forward slash: reject `//host` and `/\host` (Next
  // decodes `/%5Chost`), both of which browsers treat as protocol-relative and
  // would navigate off-origin.
  const callbackUrl =
    rawCallback &&
    rawCallback.startsWith('/') &&
    !rawCallback.startsWith('//') &&
    !rawCallback.startsWith('/\\')
      ? rawCallback
      : '/';

  if (session?.user?.id) redirect(callbackUrl);

  const google = !!(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
  const apple = !!(process.env.AUTH_APPLE_ID && process.env.AUTH_APPLE_SECRET);

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-sm flex-col justify-center px-4 py-10">
      <h1 className="mb-1 font-fungal text-3xl text-ink-100">welcome</h1>
      <p className="mb-6 font-mono text-xs text-ink-500">
        sign in to upload and manage your images.
      </p>
      <SignInForm
        callbackUrl={callbackUrl}
        providers={{ google, apple }}
        initialError={searchParams.error ?? null}
      />
    </div>
  );
}
