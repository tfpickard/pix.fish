'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';

// Clears the basement unlock cookie and redirects to the main gallery.
// Rendered at the bottom of /basement so a visitor can self-lock without
// knowing there's an API -- it just looks like "leave the basement".
export function LockBasementButton() {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function lock() {
    startTransition(async () => {
      await fetch('/api/basement-toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'lock' })
      });
      // Redirect to the main gallery after locking -- the basement page
      // would 404 on the next render anyway since the cookie is gone.
      router.push('/');
      router.refresh();
    });
  }

  return (
    <button
      type="button"
      onClick={lock}
      disabled={isPending}
      className="font-mono text-xs text-[#2a4e2a] transition-colors hover:text-[#4a6e4a] disabled:opacity-50"
    >
      {isPending ? 'locking...' : 'leave the basement'}
    </button>
  );
}
