'use client';

import { useCallback, useEffect, useState } from 'react';
import { FishSprite } from './fish-sprite';
import { readFishDismissed, writeFishDismissed } from './prefs';
import { useFishBrain } from './use-fish-brain';
import { DEFAULT_FISH_MORPH_CONFIG, type FishMorphConfig } from '@/lib/fish/config';

// Top-level mascot component. Mounted once in the root layout, outside
// <main> and the <Providers> tree so it never participates in document
// flow (zero layout shift) and isn't affected by Suspense boundaries on
// any page.
//
// SSR-safe two-phase mount mirrors temperature-hud-shell.tsx: the server
// renders the reopen dot only; the client reconciles to the persisted
// preference after mount. This avoids a hydration mismatch and a flash of
// fish on first paint for dismissed visitors.

export function PixFish() {
  const [mounted, setMounted] = useState(false);
  const [dismissed, setDismissed] = useState(true);
  // Global morph tunables (admin-editable at /admin/fish). Start from defaults
  // -- which match the committed look -- then reconcile to the live config, so
  // there's no flash unless an admin has changed it.
  const [config, setConfig] = useState<FishMorphConfig>(DEFAULT_FISH_MORPH_CONFIG);

  useEffect(() => {
    setMounted(true);
    setDismissed(readFishDismissed());
    let cancelled = false;
    fetch('/api/fish-config')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data?.config) setConfig(data.config as FishMorphConfig);
      })
      .catch(() => {
        /* keep defaults on any failure -- the mascot still works */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = useCallback(() => {
    setDismissed(true);
    writeFishDismissed(true);
  }, []);

  const reopen = useCallback(() => {
    setDismissed(false);
    writeFishDismissed(false);
  }, []);

  const { state, setContainerRef, setMorphGroupRef, setWarpRef, startle } = useFishBrain({
    paused: !mounted || dismissed,
    config
  });

  const onClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      startle(e.clientX, e.clientY);
    },
    [startle]
  );

  // Pre-mount and dismissed: render only a tiny reopen affordance in the
  // bottom-left corner (HUD owns bottom-right at z-40). The button is
  // intentionally muted so it doesn't compete with site chrome.
  if (!mounted || dismissed) {
    return (
      <button
        type="button"
        onClick={reopen}
        aria-label="show pix fish"
        className="fixed bottom-4 left-4 z-40 h-7 w-7 rounded-full border border-ink-800/70 bg-ink-950/80 font-mono text-[10px] text-ink-500 backdrop-blur transition-colors hover:text-ink-200"
      >
        ~
      </button>
    );
  }

  return (
    <>
      {/* The fish itself. Outer container does fixed positioning + the per-
          frame translate (set imperatively by the brain). pointer-events
          are off by default so the fish doesn't eat clicks on cards as it
          drifts past; an inner clickable layer re-enables them only over
          the sprite's bounding box. */}
      <div
        ref={setContainerRef}
        aria-hidden="true"
        className="pointer-events-none fixed left-0 top-0 z-30 text-ink-100"
        style={{ width: 72, height: 43, willChange: 'transform' }}
      >
        <div
          onClick={onClick}
          className={
            state.behavior === 'hiding'
              ? 'pointer-events-none'
              : 'pointer-events-auto cursor-pointer'
          }
          style={{
            width: 72,
            height: 43,
            transform: `scaleX(${state.facing})`,
            transition: 'transform 220ms ease-in-out'
          }}
        >
          <FishSprite
            eyeState={state.eyeState}
            mouthState={state.mouthState}
            morphProgress={state.morphProgress}
            width={72}
            morphGroupRef={setMorphGroupRef}
            warpRef={setWarpRef}
            config={config}
          />
        </div>
      </div>

      {/* Dismiss affordance. Lives near the reopen-dot location so the
          visitor learns the control's home corner. Only shown when the
          fish is active. */}
      <button
        type="button"
        onClick={dismiss}
        aria-label="hide pix fish"
        title="hide pix fish"
        className="fixed bottom-4 left-4 z-40 h-7 w-7 rounded-full border border-ink-800/70 bg-ink-950/60 font-mono text-[10px] text-ink-500 backdrop-blur transition-colors hover:text-ink-200"
      >
        x
      </button>
    </>
  );
}
