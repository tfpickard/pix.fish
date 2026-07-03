'use client';

import { useState, useTransition } from 'react';
import { signIn } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Props = {
  callbackUrl: string;
  providers: { google: boolean; apple: boolean };
  initialError?: string | null;
};

// Maps the ?error= codes Auth.js appends on a failed redirect-based sign-in
// into something readable. The credentials flow uses redirect:false so it
// surfaces its own message instead.
function friendlyError(code: string | null): string | null {
  if (!code) return null;
  switch (code) {
    case 'OAuthAccountNotLinked':
      return 'that email is already linked to a different sign-in method.';
    case 'CredentialsSignin':
      return 'invalid email or password.';
    default:
      return 'sign-in failed -- please try again.';
  }
}

export function SignInForm({ callbackUrl, providers, initialError }: Props) {
  const [mode, setMode] = useState<'signin' | 'register'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(friendlyError(initialError ?? null));
  const [pending, startTransition] = useTransition();

  function oauth(provider: string) {
    setError(null);
    void signIn(provider, { callbackUrl });
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !password) {
      setError('email and password are required.');
      return;
    }
    if (mode === 'register' && password.length < 8) {
      setError('password must be at least 8 characters.');
      return;
    }

    startTransition(async () => {
      try {
        if (mode === 'register') {
          const res = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: cleanEmail, password, name: name.trim() || undefined })
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            setError(data.error ?? 'could not create account.');
            return;
          }
        }

        // Both paths finish by minting the session through Credentials.
        const result = await signIn('credentials', {
          email: cleanEmail,
          password,
          redirect: false
        });
        if (!result || result.error) {
          setError('invalid email or password.');
          return;
        }
        // Full navigation so server components pick up the new session.
        window.location.assign(callbackUrl);
      } catch {
        setError('network error -- please try again.');
      }
    });
  }

  const anyOAuth = providers.google || providers.apple || true; // GitHub always on

  return (
    <div className="space-y-5">
      {anyOAuth && (
        <div className="space-y-2">
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() => oauth('github')}
            disabled={pending}
          >
            continue with GitHub
          </Button>
          {providers.google && (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => oauth('google')}
              disabled={pending}
            >
              continue with Google
            </Button>
          )}
          {providers.apple && (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => oauth('apple')}
              disabled={pending}
            >
              continue with Apple
            </Button>
          )}
        </div>
      )}

      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-ink-800" />
        <span className="font-mono text-[10px] uppercase tracking-wide text-ink-600">or</span>
        <span className="h-px flex-1 bg-ink-800" />
      </div>

      <form onSubmit={submit} className="space-y-3">
        {mode === 'register' && (
          <Input
            type="text"
            placeholder="display name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            autoComplete="name"
          />
        )}
        <Input
          type="email"
          placeholder="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
        />
        <Input
          type="password"
          placeholder="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={mode === 'register' ? 8 : undefined}
          autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
        />

        {error && <p className="font-mono text-xs text-destructive">{error}</p>}

        <Button type="submit" variant="primary" className="w-full" disabled={pending}>
          {pending
            ? mode === 'register'
              ? 'creating account...'
              : 'signing in...'
            : mode === 'register'
              ? 'create account'
              : 'sign in'}
        </Button>
      </form>

      <p className="text-center font-mono text-xs text-ink-500">
        {mode === 'signin' ? (
          <>
            no account?{' '}
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => {
                setError(null);
                setMode('register');
              }}
            >
              create one
            </button>
          </>
        ) : (
          <>
            already have an account?{' '}
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => {
                setError(null);
                setMode('signin');
              }}
            >
              sign in
            </button>
          </>
        )}
      </p>
    </div>
  );
}
