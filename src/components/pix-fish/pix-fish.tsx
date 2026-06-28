'use client';

import { useCallback, useEffect, useState } from 'react';
import { FishEntity } from './fish-entity';
import { readFishDismissed, writeFishDismissed } from './prefs';
import { useFishSim } from './use-fish-sim';
import { DEBUG_FAST_EVENTS, MAX_FILTERED_FISH } from './sim-config';
import { DEFAULT_FISH_MORPH_CONFIG, type FishMorphConfig } from '@/lib/fish/config';

// The tank. Mounted once in the root layout, outside <main> and <Providers> so
// it never participates in document flow (zero layout shift) and survives route
// changes. It owns dismiss/reopen + the live morph config, and renders the
// keyed fish list driven by the single simulation in useFishSim. Births mount
// and deaths unmount cleanly; the sim handles all per-frame motion via refs.
//
// SSR-safe two-phase mount: the server renders the reopen dot only; the client
// reconciles to the persisted preference after mount (no hydration mismatch, no
// flash of fish for dismissed visitors).

export function PixFish() {
  const [mounted, setMounted] = useState(false);
  const [dismissed, setDismissed] = useState(true);
  const [config, setConfig] = useState<FishMorphConfig>(DEFAULT_FISH_MORPH_CONFIG);

  useEffect(() => {
    setMounted(true);
    setDismissed(readFishDismissed());
    let cancelled = false;

    const load = () =>
      fetch('/api/fish-config')
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!cancelled && data?.config) setConfig(data.config as FishMorphConfig);
        })
        .catch(() => {
          /* keep defaults on any failure -- the tank still works */
        });
    load();

    // Pick up admin edits without a reload: the /admin/fish page broadcasts the
    // saved config on the same channel, and we re-pull when the tab refocuses.
    const channel =
      typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('pix-fish-config') : null;
    if (channel) {
      channel.onmessage = (e) => {
        if (!cancelled && e.data?.config) setConfig(e.data.config as FishMorphConfig);
      };
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') load();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      channel?.close();
      document.removeEventListener('visibilitychange', onVisible);
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

  const { entities, register, unregister, scatter, debug } = useFishSim({
    paused: !mounted || dismissed,
    config
  });

  // Pre-mount and dismissed: render only a tiny reopen affordance in the
  // bottom-left corner (HUD owns bottom-right at z-40).
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
      {entities.map((view, i) => (
        <FishEntity
          key={view.id}
          view={view}
          // Perf gate: only the first N fish get the expensive displacement warp;
          // the rest fall back to squash/stretch. Recomputed only here, on
          // membership change -- stable across frames.
          warpEnabled={i < MAX_FILTERED_FISH}
          config={config}
          register={register}
          unregister={unregister}
          onScatter={scatter}
        />
      ))}

      {DEBUG_FAST_EVENTS && (
        <div className="pointer-events-none fixed bottom-4 left-14 z-40 rounded border border-ink-800/70 bg-ink-950/80 px-2 py-1 font-mono text-[10px] text-ink-400 backdrop-blur">
          pop {debug.population} · {debug.lastEvent}
        </div>
      )}

      {/* Dismiss affordance -- hides the whole tank. */}
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
