'use client';

import { useState, useEffect } from 'react';
import { ThumbsUp, ThumbsDown } from 'lucide-react';

type Counts = { up: number; down: number };
type Kind = 'up' | 'down' | null;

const FP_KEY = 'pix_fp';

function getFingerprint(): string {
  if (typeof window === 'undefined') return '';
  let fp = localStorage.getItem(FP_KEY);
  if (!fp) {
    fp = crypto.randomUUID();
    localStorage.setItem(FP_KEY, fp);
  }
  return fp;
}

function getStoredReaction(slug: string): Kind {
  try {
    return (localStorage.getItem(`react:${slug}`) as Kind) ?? null;
  } catch {
    return null;
  }
}

function setStoredReaction(slug: string, kind: Kind) {
  try {
    if (kind) localStorage.setItem(`react:${slug}`, kind);
    else localStorage.removeItem(`react:${slug}`);
  } catch {
    // localStorage unavailable -- ignore
  }
}

export function ReactionBar({ slug, initialCounts }: { slug: string; initialCounts: Counts }) {
  const [counts, setCounts] = useState(initialCounts);
  const [active, setActive] = useState<Kind>(null);
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
    const next: Kind = active === kind ? null : kind;

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
        const serverActive: Kind = data.active ? kind : null;
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

  return (
    <div className="flex items-center justify-center gap-6 border-t border-ink-800 pt-4">
      <button
        type="button"
        onClick={() => react('up')}
        disabled={pending}
        aria-label={`${counts.up} upvotes`}
        className={[
          'flex items-center gap-1.5 font-mono text-xs transition-colors disabled:opacity-50',
          active === 'up'
            ? 'text-primary'
            : 'text-ink-500 hover:text-primary'
        ].join(' ')}
      >
        <ThumbsUp size={13} strokeWidth={active === 'up' ? 2.5 : 1.5} />
        <span>{counts.up}</span>
      </button>

      <button
        type="button"
        onClick={() => react('down')}
        disabled={pending}
        aria-label={`${counts.down} downvotes`}
        className={[
          'flex items-center gap-1.5 font-mono text-xs transition-colors disabled:opacity-50',
          active === 'down'
            ? 'text-secondary'
            : 'text-ink-500 hover:text-secondary'
        ].join(' ')}
      >
        <ThumbsDown size={13} strokeWidth={active === 'down' ? 2.5 : 1.5} />
        <span>{counts.down}</span>
      </button>
    </div>
  );
}
