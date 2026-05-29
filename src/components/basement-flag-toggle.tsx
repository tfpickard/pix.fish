'use client';

import { useState, useTransition } from 'react';

type Props = {
  imageId: number;
  initialBasement: boolean;
};

// Admin-only button that moves an image to (or from) the basement.
// Rendered in the image detail view only when the viewer is site admin.
// The API call hits /api/admin/basement which re-gates with isSiteAdmin
// server-side, so a non-admin can't flip the flag by calling it directly.
export function BasementFlagToggle({ imageId, initialBasement }: Props) {
  const [basement, setBasement] = useState(initialBasement);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggle() {
    setError(null);
    startTransition(async () => {
      const res = await fetch('/api/admin/basement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageId, basement: !basement })
      });
      if (res.ok) {
        const data = (await res.json()) as { image: { basement: boolean } };
        setBasement(data.image.basement);
      } else {
        const data = await res.json().catch(() => ({})) as Record<string, unknown>;
        setError(typeof data.error === 'string' ? data.error : 'flag update failed');
      }
    });
  }

  return (
    <div className="flex flex-col items-center gap-1 border-t border-ink-800 pt-4">
      <button
        type="button"
        onClick={toggle}
        disabled={isPending}
        className={`font-mono text-xs uppercase tracking-wide transition-colors disabled:opacity-50 ${
          basement
            ? 'text-[#4a6e4a] hover:text-[#7fff7f]'
            : 'text-ink-500 hover:text-[#4a6e4a]'
        }`}
      >
        {isPending
          ? 'updating...'
          : basement
            ? 'unbasement this image'
            : 'move to basement'}
      </button>
      {basement ? (
        <span className="font-mono text-[10px] text-[#2a4e2a]">in basement</span>
      ) : null}
      {error ? <p className="font-mono text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
