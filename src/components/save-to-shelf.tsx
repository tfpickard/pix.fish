'use client';

import { Bookmark, BookmarkCheck } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

const FP_KEY = 'pix_fp';
const SHELF_SLUG_KEY = 'pix_shelf_slug';
// Saved-state localStorage is keyed by `pix_saved:<imageId>`. imageId is
// globally unique (PK in the images table); the previous slug-based key
// could collide because slugs are per-owner-unique only.
const SAVED_KEY_PREFIX = 'pix_saved:';

function getOrCreateFingerprint(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    let fp = localStorage.getItem(FP_KEY);
    if (!fp) {
      fp = crypto.randomUUID();
      localStorage.setItem(FP_KEY, fp);
    }
    return fp;
  } catch {
    // localStorage blocked (Safari private mode, etc.). We deliberately
    // return null instead of a fresh random UUID -- a per-call random
    // would be useless for the (ownerHash, fingerprint) ownership
    // tuple and would leak orphaned shelves on every save attempt.
    return null;
  }
}

function readShelfSlug(): string | null {
  try {
    return localStorage.getItem(SHELF_SLUG_KEY);
  } catch {
    return null;
  }
}

function writeShelfSlug(slug: string | null) {
  try {
    if (slug) localStorage.setItem(SHELF_SLUG_KEY, slug);
    else localStorage.removeItem(SHELF_SLUG_KEY);
  } catch {
    /* localStorage unavailable -- skip */
  }
}

function readLocalSaved(imageId: number): boolean {
  try {
    return localStorage.getItem(SAVED_KEY_PREFIX + imageId) === '1';
  } catch {
    return false;
  }
}

function writeLocalSaved(imageId: number, saved: boolean) {
  try {
    if (saved) localStorage.setItem(SAVED_KEY_PREFIX + imageId, '1');
    else localStorage.removeItem(SAVED_KEY_PREFIX + imageId);
  } catch {
    /* skip */
  }
}

// "Save to my shelf" affordance. The shelf is created lazily on first
// save: server resolves (ownerHash, fingerprint) -> shelf or mints
// one. The slug comes back; we persist it so the visitor can click
// through to /c/<slug>.
export function SaveToShelf({ imageId }: { imageId: number }) {
  const [saved, setSaved] = useState(false);
  const [shelfSlug, setShelfSlug] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setSaved(readLocalSaved(imageId));
    setShelfSlug(readShelfSlug());
  }, [imageId]);

  async function toggle() {
    if (pending) return;
    setPending(true);
    const next = !saved;

    // Optimistic flip; revert on error.
    setSaved(next);
    writeLocalSaved(imageId, next);

    try {
      const fingerprint = getOrCreateFingerprint();
      const res = await fetch('/api/me/shelf', {
        method: next ? 'POST' : 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageId, fingerprint })
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      if (data?.shelf?.slug) {
        writeShelfSlug(data.shelf.slug);
        setShelfSlug(data.shelf.slug);
      }
    } catch {
      // Revert
      setSaved(!next);
      writeLocalSaved(imageId, !next);
    } finally {
      setPending(false);
    }
  }

  const Icon = saved ? BookmarkCheck : Bookmark;
  const label = saved ? 'on your shelf' : 'save to shelf';

  return (
    <div className="flex items-center justify-center gap-3 font-mono text-xs text-ink-500">
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        aria-label={label}
        title={label}
        className={[
          'flex items-center gap-1.5 transition-colors disabled:opacity-50',
          saved ? 'text-primary' : 'hover:text-primary'
        ].join(' ')}
      >
        <Icon size={14} strokeWidth={saved ? 2.25 : 1.5} />
        <span>{label}</span>
      </button>
      {shelfSlug ? (
        <Link
          href={`/c/${shelfSlug}`}
          className="text-ink-500 hover:text-ink-200"
          title={`open shelf /c/${shelfSlug}`}
        >
          open shelf &rarr;
        </Link>
      ) : null}
    </div>
  );
}
