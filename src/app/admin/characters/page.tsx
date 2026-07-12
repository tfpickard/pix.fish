'use client';

import { useEffect, useState, useTransition } from 'react';

// Admin controls for the character pipeline. Gating is enforced by the API
// routes (isSiteAdmin). Two actions -- detect crops across images, then run the
// clustering pipeline (cluster -> verify -> census) -- plus tuning sliders for
// the clustering knobs. The knobs persist server-side so they become defaults;
// re-clustering is vector-only, so sweeping a slider + re-running is seconds-fast.

type Space = 'text' | 'visual' | 'blend';
type Tuning = {
  maxDist: number;
  k: number;
  pruneK: number;
  minAppearances: number;
  verifyEnabled: boolean;
  space: Space;
  blendWeight: number;
};

const DEFAULTS: Tuning = {
  maxDist: 0.45,
  k: 5,
  pruneK: 4,
  minAppearances: 2,
  verifyEnabled: true,
  space: 'text',
  blendWeight: 0.5
};

function Slider({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block space-y-1">
      <div className="flex items-baseline justify-between font-mono text-xs">
        <span className="text-ink-200">{label}</span>
        <span className="text-primary">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-primary"
      />
      <p className="font-mono text-[10px] leading-tight text-ink-600">{hint}</p>
    </label>
  );
}

export default function AdminCharactersPage() {
  const [isPending, startTransition] = useTransition();
  const [info, setInfo] = useState<string | null>(null);
  const [tuning, setTuning] = useState<Tuning>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch('/api/admin/characters/tuning')
      .then((r) => (r.ok ? r.json() : DEFAULTS))
      .then((t) => setTuning({ ...DEFAULTS, ...t }))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  function set<K extends keyof Tuning>(key: K, value: Tuning[K]) {
    setTuning((t) => ({ ...t, [key]: value }));
  }

  function run(path: string, label: string, body?: Record<string, unknown>) {
    setInfo(null);
    startTransition(async () => {
      try {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {})
        });
        const data = await res.json();
        setInfo(
          res.ok
            ? `${label}: ${JSON.stringify(data)} -- wait for the cron to drain the queue.`
            : `${label} error: ${data.error ?? 'failed'}`
        );
      } catch (err) {
        setInfo(`${label} error: ${String(err)}`);
      }
    });
  }

  function saveTuning() {
    setInfo(null);
    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/characters/tuning', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(tuning)
        });
        setInfo(res.ok ? 'tuning saved.' : 'tuning save failed.');
      } catch (err) {
        setInfo(`tuning error: ${String(err)}`);
      }
    });
  }

  return (
    <div className="max-w-2xl space-y-6 pt-4">
      <h1 className="font-display text-3xl text-ink-100">characters</h1>
      <p className="font-mono text-xs text-ink-500">
        1) detect + crop figures across every eligible specimen, then 2) cluster the crops into
        recurring characters and file the census. Both enqueue jobs; the per-minute cron drains
        them. Clustering runs cluster {'->'} verify {'->'} census.
      </p>

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => run('/api/admin/characters/detect', 'detect')}
          disabled={isPending}
          className="rounded border border-primary/50 bg-primary/10 px-3 py-1.5 font-mono text-xs text-primary hover:bg-primary/20 disabled:opacity-50"
        >
          {isPending ? 'working...' : 'detect all'}
        </button>
        <button
          type="button"
          onClick={() => run('/api/admin/characters/detect', 're-detect', { force: true })}
          disabled={isPending}
          className="rounded border border-ink-700 px-3 py-1.5 font-mono text-xs text-ink-300 hover:text-ink-100 disabled:opacity-50"
        >
          re-detect (force)
        </button>
        <button
          type="button"
          onClick={() => run('/api/admin/characters/backfill', 'backfill-visuals')}
          disabled={isPending}
          className="rounded border border-ink-700 px-3 py-1.5 font-mono text-xs text-ink-300 hover:text-ink-100 disabled:opacity-50"
          title="Compute Voyage visual vectors for crops that lack one (needs VOYAGE_API_KEY)"
        >
          backfill visual vectors
        </button>
      </div>

      <section className="space-y-4 rounded border border-ink-800 p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-mono text-xs uppercase tracking-wide text-ink-400">clustering knobs</h2>
          <span className="font-mono text-[10px] text-ink-600">{loaded ? '' : 'loading...'}</span>
        </div>

        <div className="space-y-1">
          <div className="font-mono text-xs text-ink-200">identity space</div>
          <div className="flex gap-2">
            {(['text', 'visual', 'blend'] as Space[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => set('space', s)}
                className={`flex-1 rounded border px-2 py-1 font-mono text-xs ${
                  tuning.space === s
                    ? 'border-primary/60 bg-primary/10 text-primary'
                    : 'border-ink-700 text-ink-500 hover:text-ink-200'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          <p className="font-mono text-[10px] leading-tight text-ink-600">
            text = description embedding (original); visual = Voyage pixel embedding of the crop;
            blend = both. visual/blend need crops backfilled (`characters:backfill-visuals`).
          </p>
        </div>

        {tuning.space === 'blend' ? (
          <Slider
            label="blendWeight (visual share)"
            hint="0 = all text, 1 = all visual. distance = (1-w)*text + w*visual."
            value={tuning.blendWeight}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => set('blendWeight', v)}
          />
        ) : null}

        <Slider
          label="maxDist (precision)"
          hint="cosine-distance cutoff. LOWER = tighter/fewer false members; higher = looser."
          value={tuning.maxDist}
          min={0.1}
          max={0.7}
          step={0.01}
          onChange={(v) => set('maxDist', v)}
        />
        <Slider
          label="k (neighbors)"
          hint="how many nearest crops each crop links to before community detection."
          value={tuning.k}
          min={1}
          max={15}
          step={1}
          onChange={(v) => set('k', v)}
        />
        <Slider
          label="pruneK"
          hint="edges kept per node in community detection. lower = more, smaller characters."
          value={tuning.pruneK}
          min={1}
          max={15}
          step={1}
          onChange={(v) => set('pruneK', v)}
        />
        <Slider
          label="minAppearances"
          hint="a character must span at least this many distinct specimens."
          value={tuning.minAppearances}
          min={2}
          max={10}
          step={1}
          onChange={(v) => set('minAppearances', v)}
        />

        <label className="flex items-center gap-2 font-mono text-xs text-ink-200">
          <input
            type="checkbox"
            checked={tuning.verifyEnabled}
            onChange={(e) => set('verifyEnabled', e.target.checked)}
            className="accent-primary"
          />
          mosaic verify pass (LLM splits look-alikes into separate characters)
        </label>

        <div className="flex flex-wrap gap-3 pt-1">
          <button
            type="button"
            onClick={saveTuning}
            disabled={isPending}
            className="rounded border border-ink-700 px-3 py-1.5 font-mono text-xs text-ink-300 hover:text-ink-100 disabled:opacity-50"
          >
            save as defaults
          </button>
          <button
            type="button"
            onClick={() => run('/api/admin/characters/cluster', 'cluster', tuning)}
            disabled={isPending}
            className="rounded border border-primary/50 bg-primary/10 px-3 py-1.5 font-mono text-xs text-primary hover:bg-primary/20 disabled:opacity-50"
          >
            cluster + census (with these knobs)
          </button>
        </div>
        <p className="font-mono text-[10px] text-ink-600">
          clustering re-reads existing crops -- no re-detection -- so sweeping a knob and re-running
          is fast. label appearances on a character page to build the eval set, then run{' '}
          <code>bun run characters:eval</code>.
        </p>
      </section>

      {info ? <p className="break-words font-mono text-xs text-ink-300">{info}</p> : null}
    </div>
  );
}
