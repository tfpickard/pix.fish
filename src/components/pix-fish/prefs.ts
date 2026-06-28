// Persistence for the pix-fish dismiss state. Mirrors the idiom in
// temperature-hud-shell.tsx (pf_hud_dismissed) deliberately so a future
// settings panel can iterate over a known prefix of pf_* keys.

const DISMISS_KEY = 'pf_fish_dismissed';
const STATS_HIDDEN_KEY = 'pf_fish_stats_hidden';

export function readFishDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeFishDismissed(value: boolean): void {
  try {
    if (value) window.localStorage.setItem(DISMISS_KEY, '1');
    else window.localStorage.removeItem(DISMISS_KEY);
  } catch {
    // Private-mode browsers can throw on localStorage writes. Dismissal
    // becomes session-only in that case, which is fine.
  }
}

// Whether the stats banner is collapsed. Note: this only applies while the fish
// are SHOWN -- when the fish are dismissed the banner is forced open (and states
// that the fish are hidden), so this preference is ignored in that case.
export function readStatsHidden(): boolean {
  try {
    return window.localStorage.getItem(STATS_HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeStatsHidden(value: boolean): void {
  try {
    if (value) window.localStorage.setItem(STATS_HIDDEN_KEY, '1');
    else window.localStorage.removeItem(STATS_HIDDEN_KEY);
  } catch {
    /* session-only fallback in private mode */
  }
}
