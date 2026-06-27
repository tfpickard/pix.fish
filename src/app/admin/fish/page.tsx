'use client';

import { useEffect, useState, useTransition } from 'react';
import {
  DEFAULT_FISH_MORPH_CONFIG,
  FISH_PARAMS,
  type FishMorphConfig
} from '@/lib/fish/config';

// /admin/fish -- tune the pix-fish mascot's Lorenz morph. Global, site-wide
// config; changes take effect for every visitor on their next page load (the
// mascot fetches /api/fish-config on mount). Self-gates via the admin API: a
// non-admin who loads this page just gets 403s and an empty form.

export default function AdminFishPage() {
  const [config, setConfig] = useState<FishMorphConfig>(DEFAULT_FISH_MORPH_CONFIG);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Turn a non-OK response into an accurate message: 403 is the only "not an
  // admin" case; anything else (e.g. a 503 when the fish_config table is
  // missing) carries the server's own explanation.
  async function messageFor(res: Response): Promise<string> {
    if (res.status === 403) return 'not authorized -- are you a site admin?';
    const body = await res.json().catch(() => null);
    return body?.error ?? `request failed (${res.status})`;
  }

  useEffect(() => {
    fetch('/api/admin/fish-config')
      .then(async (r) => {
        if (!r.ok) {
          setError(await messageFor(r));
          setLoading(false);
          return;
        }
        const data = await r.json();
        if (data?.config) setConfig({ ...DEFAULT_FISH_MORPH_CONFIG, ...data.config });
        setLoading(false);
      })
      .catch(() => {
        setError('could not reach the server');
        setLoading(false);
      });
  }, []);

  function set(key: keyof FishMorphConfig, value: number) {
    setConfig((c) => ({ ...c, [key]: value }));
    setDirty(true);
    setSaved(false);
    setError(null);
  }

  function save() {
    startTransition(async () => {
      const res = await fetch('/api/admin/fish-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.config) setConfig({ ...DEFAULT_FISH_MORPH_CONFIG, ...data.config });
        setDirty(false);
        setError(null);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } else {
        setError(await messageFor(res));
      }
    });
  }

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="font-display text-3xl text-ink-100">fish morph</h1>
      <p className="font-mono text-xs text-ink-500">
        shape + size of the pix-fish mascot, driven by a lorenz attractor. global
        for every visitor; changes apply on the next page load. set warp to 0 to
        turn off the outline-warp filter entirely.
      </p>

      {loading ? (
        <p className="font-mono text-xs text-ink-500">loading...</p>
      ) : (
        <div className="space-y-3">
          {FISH_PARAMS.map((p) => {
            const value = config[p.key];
            return (
              <div key={p.field} className="rounded border border-ink-800 p-3">
                <div className="flex items-center gap-3">
                  <label
                    htmlFor={`fish-${p.field}`}
                    className="w-32 shrink-0 font-mono text-xs text-ink-300"
                  >
                    {p.label}
                  </label>
                  <input
                    id={`fish-${p.field}`}
                    type="range"
                    min={p.min}
                    max={p.max}
                    step={p.step}
                    value={value}
                    onChange={(e) => set(p.key, Number(e.target.value))}
                    className="flex-1 accent-primary"
                  />
                  <input
                    type="number"
                    min={p.min}
                    max={p.max}
                    step={p.step}
                    value={value}
                    onChange={(e) => set(p.key, Number(e.target.value))}
                    className="w-20 rounded border border-ink-800 bg-ink-950 px-2 py-1 text-right font-mono text-xs text-ink-100"
                  />
                </div>
                {p.hint && <p className="mt-1 pl-[8.75rem] font-mono text-[10px] text-ink-600">{p.hint}</p>}
              </div>
            );
          })}

          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              onClick={save}
              disabled={isPending || !dirty}
              className="rounded border border-primary/50 bg-primary/10 px-4 py-1.5 font-mono text-xs text-primary hover:bg-primary/20 disabled:opacity-50"
            >
              {isPending ? 'saving...' : 'save'}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfig(DEFAULT_FISH_MORPH_CONFIG);
                setDirty(true);
                setSaved(false);
                setError(null);
              }}
              disabled={isPending}
              className="rounded border border-ink-800 px-4 py-1.5 font-mono text-xs text-ink-400 hover:text-ink-100 disabled:opacity-50"
            >
              reset to defaults
            </button>
            {saved && <span className="font-mono text-xs text-primary">saved</span>}
            {error && <span className="font-mono text-xs text-red-400">{error}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
