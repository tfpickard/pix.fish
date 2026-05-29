'use client';

import { useEffect, useState } from 'react';
import { isDoNotTrack, isOptedOut, setOptedOut } from '@/lib/attention-client';

// Visible, persistent opt-out control for attention telemetry.
//
// Privacy: this is the user-facing half of the consent posture in
// attention-client.ts. When the browser sends Do Not Track we say so and offer
// no toggle (collection is already fully off and not user-overridable upward).
// Otherwise the visitor can opt out at any time; the choice persists in
// localStorage and takes effect immediately (the grid re-checks the gate on
// every flush). Styling mirrors nsfw-toggle.tsx.
export function AttentionToggle() {
  // Start in a neutral state and resolve client-side to avoid an SSR/CSR
  // mismatch (localStorage + navigator are client-only).
  const [mounted, setMounted] = useState(false);
  const [dnt, setDnt] = useState(false);
  const [optedOut, setOpted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setDnt(isDoNotTrack());
    setOpted(isOptedOut());
  }, []);

  if (!mounted) return null;

  if (dnt) {
    return (
      <p className="text-center font-mono text-[11px] text-ink-500">
        attention telemetry off -- honoring your browser&apos;s Do Not Track
      </p>
    );
  }

  const collecting = !optedOut;
  return (
    <div className="text-center font-mono text-[11px] text-ink-500">
      <span>
        anonymous attention {collecting ? 'on' : 'off'} (aggregate dwell only, no
        personal data)
      </span>{' '}
      <button
        type="button"
        onClick={() => {
          const next = !optedOut;
          setOptedOut(next);
          setOpted(next);
        }}
        className="underline decoration-dotted underline-offset-2 hover:text-ink-100"
      >
        {collecting ? 'opt out' : 'opt back in'}
      </button>
    </div>
  );
}
