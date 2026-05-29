'use client';

import { useState, useEffect } from 'react';

export type ReactionCounts = { up: number; down: number };
export type ReactionKind = 'up' | 'down' | null;

const FP_KEY = 'pix_fp';

function getFingerprint(): string {
  if (typeof window === 'undefined') return '';
  try {
    let fp = localStorage.getItem(FP_KEY);
    if (!fp) {
      fp = crypto.randomUUID();
      localStorage.setItem(FP_KEY, fp);
    }
    return fp;
  } catch {
    // localStorage blocked (Safari private mode, etc.) -- use a session-only UUID
    return crypto.randomUUID();
  }
}

function getStoredReaction(slug: string): ReactionKind {
  try {
    return (localStorage.getItem(`react:${slug}`) as ReactionKind) ?? null;
  } catch {
    return null;
  }
}

function setStoredReaction(slug: string, kind: ReactionKind) {
  try {
    if (kind) localStorage.setItem(`react:${slug}`, kind);
    else localStorage.removeItem(`react:${slug}`);
  } catch {
    // localStorage unavailable -- ignore
  }
}

// Shared voting state + toggle logic. The detail-page ReactionBar and the
// gallery CardEngagement both drive the same /api/images/:slug/reactions
// endpoint, so the optimistic-update + localStorage de-dupe lives here once.
export function useReaction(slug: string, initialCounts: ReactionCounts) {
  const [counts, setCounts] = useState(initialCounts);
  const [active, setActive] = useState<ReactionKind>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setActive(getStoredReaction(slug));
  }, [slug]);

  async function react(kind: 'up' | 'down') {
    if (pending) return;
    setPending(true);

    // Optimistic update
    const prev = active;
    const prevCounts = counts;
    const next: ReactionKind = active === kind ? null : kind;

    const delta = (k: 'up' | 'down'): number => {
      if (k === kind && active === kind) return -1; // removing
      if (k === kind) return 1;                     // adding
      if (k === prev && prev !== null) return -1;   // switching away
      return 0;
    };

    setActive(next);
    setCounts({ up: counts.up + delta('up'), down: counts.down + delta('down') });
    setStoredReaction(slug, next);

    try {
      const res = await fetch(`/api/images/${encodeURIComponent(slug)}/reactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, fingerprint: getFingerprint() })
      });
      if (res.ok) {
        const data = await res.json();
        setCounts(data.counts);
        const serverActive: ReactionKind = data.active ? kind : null;
        setActive(serverActive);
        setStoredReaction(slug, serverActive);
      } else {
        // Revert on error
        setActive(prev);
        setCounts(prevCounts);
        setStoredReaction(slug, prev);
      }
    } catch {
      setActive(prev);
      setCounts(prevCounts);
      setStoredReaction(slug, prev);
    } finally {
      setPending(false);
    }
  }

  return { counts, active, pending, react };
}
