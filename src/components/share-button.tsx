'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type ButtonState = 'idle' | 'sharing' | 'copied' | 'failed';

// Dynamic share: reads document.title + window.location.href at click time so
// one button covers every page without prop plumbing. The Metadata API already
// sets a correct <title> for every route (home, /[slug], /tag/*, etc.), so
// trimming the " -- pix.fish" suffix gives a usable share title for free.
export function ShareButton() {
  const [state, setState] = useState<ButtonState>('idle');
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  const handle = useCallback(async () => {
    if (state === 'sharing') return;

    const url = window.location.href;
    const rawTitle = document.title || 'pix.fish';
    // Strip the " -- pix.fish" suffix so share text doesn't read as
    // "sunset -- pix.fish" when the suffix is implicit in the destination URL.
    const title = rawTitle.replace(/\s*--\s*pix\.fish\s*$/i, '');
    const shareData: ShareData = { title, url, text: title };

    setState('sharing');
    try {
      // Web Share API is the best experience where supported (iOS, Android,
      // and desktop Safari/Chrome on recent versions). canShare is the
      // capability check -- some UAs expose navigator.share but reject
      // specific payloads, hence passing shareData through canShare first.
      if (
        typeof navigator !== 'undefined' &&
        typeof navigator.share === 'function' &&
        (typeof navigator.canShare !== 'function' || navigator.canShare(shareData))
      ) {
        await navigator.share(shareData);
        setState('idle');
        return;
      }

      // Fallback: clipboard copy. Most desktop browsers where Web Share isn't
      // available still grant writeText in a user gesture.
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        flash('copied');
        return;
      }

      // Locked-down browser with neither API (old Safari, some embedded
      // webviews). Warn so the failure is traceable in console rather than
      // looking like a UI bug.
      console.warn('share-button: neither navigator.share nor clipboard.writeText is available');
      flash('failed');
    } catch (err) {
      // AbortError = user dismissed the native share sheet. Not an error
      // worth surfacing; just reset.
      if (err instanceof DOMException && err.name === 'AbortError') {
        setState('idle');
        return;
      }
      console.error('share failed', err);
      flash('failed');
    }

    function flash(next: 'copied' | 'failed') {
      setState(next);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setState('idle'), 1500);
    }
  }, [state]);

  const label =
    state === 'copied' ? 'copied!' : state === 'failed' ? 'failed' : state === 'sharing' ? '...' : 'share';

  return (
    <button
      type="button"
      onClick={handle}
      aria-label="share this page"
      className="font-mono text-xs text-ink-400 transition-colors hover:text-ink-100 disabled:opacity-50"
      disabled={state === 'sharing'}
    >
      {label}
    </button>
  );
}
