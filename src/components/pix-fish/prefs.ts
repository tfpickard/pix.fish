// Persistence for the pix-fish dismiss state. Mirrors the idiom in
// temperature-hud-shell.tsx (pf_hud_dismissed) deliberately so a future
// settings panel can iterate over a known prefix of pf_* keys.

const DISMISS_KEY = 'pf_fish_dismissed';

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
