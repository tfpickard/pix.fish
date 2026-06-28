'use client';

import { useState } from 'react';
import { readStatsHidden, writeStatsHidden } from './prefs';
import type { FishStats } from './stats';

// The stats banner: a slim top bar showing the tank's lifetime totals and rolling
// windowed averages. It can be collapsed to a small chip -- BUT only while the
// fish are shown. When the fish are dismissed the banner is forced open and just
// states that the fish are hidden (with a "show" affordance); the hide control
// disappears, so the notice can't itself be hidden.

interface FishStatsBannerProps {
  stats: FishStats | null;
  // The whole tank is dismissed (fish animations off).
  fishHidden: boolean;
  // Bring the fish back (clears the dismiss).
  onShowFish: () => void;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <span className="whitespace-nowrap">
      <span className="text-ink-500">{label}</span> <span className="text-ink-200">{value}</span>
    </span>
  );
}

const f1 = (n: number) => n.toFixed(1);

export function FishStatsBanner({ stats, fishHidden, onShowFish }: FishStatsBannerProps) {
  // Own collapsed state, persisted. This component only ever mounts client-side
  // (its parent gates on `mounted`), so reading the pref in the initializer is
  // safe and avoids a flash of the open banner for users who collapsed it.
  const [hidden, setHidden] = useState(readStatsHidden);

  const hide = () => {
    setHidden(true);
    writeStatsHidden(true);
  };
  const show = () => {
    setHidden(false);
    writeStatsHidden(false);
  };

  // Anchored just below the site NavBar (sticky top-0, z-40, h-14 = 56px) so the
  // header never covers it -- this is what bit iOS Safari. Sits a level below the
  // nav AND below the mobile hamburger panel (also at top-14, z-30), so an open
  // menu cleanly covers the banner rather than fighting it.
  const barClass =
    'fixed inset-x-0 top-14 z-20 flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-ink-800/70 bg-ink-950/80 px-3 py-1.5 font-mono text-[11px] text-ink-300 backdrop-blur';

  // Fish dismissed: forced-open notice, no hide control.
  if (fishHidden) {
    return (
      <div className={barClass} role="status">
        <span className="whitespace-nowrap">
          <span aria-hidden="true">🐟</span> <span className="text-ink-200">pix-fish are hidden</span>
          <span className="text-ink-500"> -- the tank is off</span>
        </span>
        {stats && stats.peak > 0 && (
          <span className="whitespace-nowrap text-ink-500">
            · peak {stats.peak} · {stats.born} born · {stats.deaths} lost
          </span>
        )}
        <button
          type="button"
          onClick={onShowFish}
          className="ml-auto rounded border border-primary/50 bg-primary/10 px-2 py-0.5 text-primary transition-colors hover:bg-primary/20"
        >
          show fish
        </button>
      </div>
    );
  }

  // Fish shown + banner collapsed: a small reopen chip.
  if (hidden) {
    return (
      <button
        type="button"
        onClick={show}
        aria-label="show fish stats"
        className="fixed right-3 top-16 z-20 rounded-full border border-ink-800/70 bg-ink-950/80 px-2 py-0.5 font-mono text-[10px] text-ink-500 backdrop-blur transition-colors hover:text-ink-200"
      >
        ▾ stats
      </button>
    );
  }

  // Fish shown + banner open: the live stats.
  return (
    <div className={barClass} role="status">
      <span className="whitespace-nowrap text-ink-400" aria-hidden="true">
        🐟 pix-fish
      </span>
      {stats ? (
        <>
          <Stat label="pop" value={stats.population} />
          <Stat label={`avg/${stats.windowSec}s`} value={f1(stats.avgPopulation)} />
          <Stat label="peak" value={stats.peak} />
          <span className="text-ink-700">|</span>
          <Stat label="born" value={stats.born} />
          {stats.immigrated > 0 && <Stat label="arrived" value={stats.immigrated} />}
          <Stat label="eaten" value={stats.eaten} />
          <Stat label="fights" value={stats.fights} />
          {stats.fightKills > 0 && <Stat label="slain" value={stats.fightKills} />}
          <Stat label="aged" value={stats.naturalDeaths} />
          {stats.emigrated > 0 && <Stat label="left" value={stats.emigrated} />}
          <span className="text-ink-700">|</span>
          <Stat label="↑/min" value={f1(stats.arrivalsPerMin)} />
          <Stat label="↓/min" value={f1(stats.departuresPerMin)} />
        </>
      ) : (
        <span className="text-ink-500">warming up...</span>
      )}
      <button
        type="button"
        onClick={hide}
        aria-label="hide fish stats"
        className="ml-auto rounded border border-ink-800/70 px-2 py-0.5 text-ink-500 transition-colors hover:text-ink-200"
      >
        hide
      </button>
    </div>
  );
}
