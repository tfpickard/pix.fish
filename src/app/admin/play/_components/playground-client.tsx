'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DIALECTS,
  DIALECT_LABELS,
  toAllDialects,
  type Dialect
} from '@/lib/playground/dialects';

type SkeletonPrompt = {
  template: string;
  slots: string[];
  filledSlots: Record<string, string>;
  frozenSlots: string[];
  rendered: string;
};

type DiceRoll = { id: number; category: string; text: string };

export type VibeAxisOption = {
  key: string;
  label: string;
  negativePole: string;
  positivePole: string;
};

const DEFAULT_N_SKELETONS = 6;
const DEFAULT_N_DICE = 3;

type Tab = 'compose' | 'equalizer' | 'surprise' | 'walk' | 'haiku';

const TABS: { id: Tab; label: string }[] = [
  { id: 'compose', label: 'compose' },
  { id: 'equalizer', label: 'equalizer' },
  { id: 'surprise', label: 'surprise' },
  { id: 'walk', label: 'walk' },
  { id: 'haiku', label: 'reverse haiku' }
];

export function PlaygroundClient({
  grammarReady,
  categories,
  cardCounts,
  vibeAxes
}: {
  grammarReady: boolean;
  categories: string[];
  cardCounts: Record<string, number>;
  vibeAxes: VibeAxisOption[];
}) {
  const [tab, setTab] = useState<Tab>('compose');
  const [skeletons, setSkeletons] = useState<SkeletonPrompt[]>([]);
  const [activeIdx, setActiveIdx] = useState<number>(0);
  // Frozen slot map is GLOBAL across re-rolls -- pinning "mundane_noun: lamp"
  // means every re-roll keeps lamp in that slot. The brief calls this out as
  // the killer interaction; keep the data flow trivial so it never surprises.
  const [frozen, setFrozen] = useState<Record<string, string>>({});
  const [skeletonLoading, setSkeletonLoading] = useState(false);

  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set(categories));
  const [rolls, setRolls] = useState<DiceRoll[]>([]);
  const [diceLoading, setDiceLoading] = useState(false);
  const [activeRollIds, setActiveRollIds] = useState<Set<number>>(new Set());

  const rollSkeletons = useCallback(async () => {
    setSkeletonLoading(true);
    try {
      const freezeStr = Object.entries(frozen)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}:${v}`)
        .join(',');
      const url = new URL('/api/admin/play/skeleton', window.location.origin);
      url.searchParams.set('n', String(DEFAULT_N_SKELETONS));
      if (freezeStr) url.searchParams.set('freeze', freezeStr);
      const res = await fetch(url, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'failed to roll skeletons');
      setSkeletons(data.prompts ?? []);
      setActiveIdx(0);
    } catch (err) {
      console.error(err);
    } finally {
      setSkeletonLoading(false);
    }
  }, [frozen]);

  const rollAllDice = useCallback(async () => {
    setDiceLoading(true);
    try {
      const url = new URL('/api/admin/play/dice', window.location.origin);
      url.searchParams.set('n', String(DEFAULT_N_DICE));
      url.searchParams.set('perCategory', '1');
      for (const c of selectedCategories) url.searchParams.append('category', c);
      const res = await fetch(url, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'failed to roll dice');
      setRolls(data.rolls ?? []);
      // New rolls reset the active-roll selection; users explicitly opt cards
      // back into the merged prompt to avoid surprise overrides.
      setActiveRollIds(new Set());
    } catch (err) {
      console.error(err);
    } finally {
      setDiceLoading(false);
    }
  }, [selectedCategories]);

  const toggleFreeze = (slotName: string, filler: string) => {
    setFrozen((prev) => {
      const next = { ...prev };
      if (next[slotName] === filler) delete next[slotName];
      else next[slotName] = filler;
      return next;
    });
  };

  const clearFrozen = () => setFrozen({});

  const toggleCategory = (c: string) => {
    setSelectedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  };

  const toggleRollActive = (id: number) => {
    setActiveRollIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const activeSkeleton = skeletons[activeIdx] ?? null;
  const activeModifiers = useMemo(
    () => rolls.filter((r) => activeRollIds.has(r.id)).map((r) => r.text),
    [rolls, activeRollIds]
  );

  const canonical = useMemo(
    () => ({
      subject: activeSkeleton?.rendered ?? '',
      modifiers: activeModifiers
    }),
    [activeSkeleton, activeModifiers]
  );

  const dialectOutputs = useMemo(() => toAllDialects(canonical), [canonical]);

  return (
    <div className="space-y-8">
      <nav className="flex flex-wrap gap-1 border-b border-ink-800 pb-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-t border-b-2 px-3 py-1 font-mono text-xs ${
              tab === t.id
                ? 'border-ink-300 text-ink-100'
                : 'border-transparent text-ink-500 hover:text-ink-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'equalizer' && <EqualizerPanel axes={vibeAxes} />}
      {tab === 'surprise' && <SurprisePanel />}
      {tab === 'walk' && <WalkPanel />}
      {tab === 'haiku' && <HaikuPanel />}

      <div className={tab === 'compose' ? 'space-y-10' : 'hidden'}>
      {/* SKELETONS */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-mono text-sm uppercase tracking-wider text-ink-300">skeleton</h2>
          <div className="flex items-center gap-2">
            {Object.keys(frozen).length > 0 && (
              <button
                onClick={clearFrozen}
                className="font-mono text-xs text-ink-500 hover:text-ink-200"
              >
                clear {Object.keys(frozen).length} pinned
              </button>
            )}
            <button
              onClick={rollSkeletons}
              disabled={!grammarReady || skeletonLoading}
              className="rounded border border-ink-700 px-3 py-1 font-mono text-xs text-ink-100 hover:bg-ink-800 disabled:opacity-40"
            >
              {skeletonLoading ? 'rolling...' : skeletons.length === 0 ? 'roll' : 're-roll'}
            </button>
          </div>
        </div>

        {Object.keys(frozen).length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10px] uppercase text-ink-600">pinned</span>
            {Object.entries(frozen).map(([slot, filler]) => (
              <button
                key={slot}
                onClick={() => toggleFreeze(slot, filler)}
                className="rounded border border-amber-700/60 bg-amber-900/20 px-2 py-0.5 font-mono text-[11px] text-amber-200 hover:bg-amber-900/40"
              >
                {slot}: {filler}
              </button>
            ))}
          </div>
        )}

        {skeletons.length === 0 ? (
          <p className="font-mono text-xs text-ink-500">
            {grammarReady ? 'click roll to generate.' : 'no grammar artifact -- see note above.'}
          </p>
        ) : (
          <ul className="space-y-2">
            {skeletons.map((s, i) => (
              <li
                key={i}
                className={`rounded border px-3 py-2 transition ${
                  i === activeIdx
                    ? 'border-ink-400 bg-ink-900/40'
                    : 'border-ink-800/60 hover:border-ink-700'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <button
                    onClick={() => setActiveIdx(i)}
                    className="text-left font-display text-base text-ink-100"
                  >
                    {s.rendered}
                  </button>
                  <CopyButton text={s.rendered} label="copy" />
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {s.slots.map((slot) => {
                    const filler = s.filledSlots[slot];
                    if (!filler) return null;
                    const isPinned = frozen[slot] === filler;
                    return (
                      <button
                        key={slot}
                        onClick={() => toggleFreeze(slot, filler)}
                        title={isPinned ? 'unpin this slot' : 'pin this filler across re-rolls'}
                        className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                          isPinned
                            ? 'bg-amber-900/40 text-amber-200'
                            : 'bg-ink-900/60 text-ink-400 hover:bg-ink-800'
                        }`}
                      >
                        <span className="opacity-60">{slot}:</span> {filler}
                      </button>
                    );
                  })}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* DICE */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-mono text-sm uppercase tracking-wider text-ink-300">dice</h2>
          <button
            onClick={rollAllDice}
            disabled={diceLoading || selectedCategories.size === 0}
            className="rounded border border-ink-700 px-3 py-1 font-mono text-xs text-ink-100 hover:bg-ink-800 disabled:opacity-40"
          >
            {diceLoading ? 'rolling...' : 'roll'}
          </button>
        </div>
        <div className="flex flex-wrap gap-1">
          {categories.map((c) => {
            const on = selectedCategories.has(c);
            const n = cardCounts[c] ?? 0;
            return (
              <button
                key={c}
                onClick={() => toggleCategory(c)}
                className={`rounded border px-2 py-0.5 font-mono text-[11px] ${
                  on
                    ? 'border-ink-500 bg-ink-800 text-ink-100'
                    : 'border-ink-800 text-ink-500 hover:border-ink-700'
                }`}
              >
                {c.replace(/_/g, ' ')} <span className="opacity-50">({n})</span>
              </button>
            );
          })}
        </div>
        {rolls.length === 0 ? (
          <p className="font-mono text-xs text-ink-500">
            select categories, click roll. tap a card to merge it into the active skeleton.
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-1 md:grid-cols-2">
            {rolls.map((r) => {
              const on = activeRollIds.has(r.id);
              return (
                <li key={r.id}>
                  <button
                    onClick={() => toggleRollActive(r.id)}
                    className={`w-full rounded border px-2 py-1 text-left transition ${
                      on
                        ? 'border-emerald-700/60 bg-emerald-900/20'
                        : 'border-ink-800/60 hover:border-ink-700'
                    }`}
                  >
                    <span className="font-mono text-[10px] uppercase text-ink-500">
                      {r.category.replace(/_/g, ' ')}
                    </span>
                    <span className="block font-display text-sm text-ink-100">{r.text}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* CLIPBOARD */}
      <section className="space-y-3">
        <h2 className="font-mono text-sm uppercase tracking-wider text-ink-300">clipboard</h2>
        {!activeSkeleton ? (
          <p className="font-mono text-xs text-ink-500">
            select a skeleton above. dialects render whatever the active skeleton + merged dice
            cards produce.
          </p>
        ) : (
          <div className="space-y-2">
            <div className="rounded border border-ink-800/60 bg-ink-900/40 px-3 py-2">
              <div className="font-mono text-[10px] uppercase text-ink-500">subject</div>
              <div className="font-display text-base text-ink-100">{canonical.subject}</div>
              {canonical.modifiers.length > 0 && (
                <>
                  <div className="mt-2 font-mono text-[10px] uppercase text-ink-500">
                    modifiers
                  </div>
                  <ul className="list-disc pl-5 font-mono text-xs text-ink-200">
                    {canonical.modifiers.map((m, i) => (
                      <li key={i}>{m}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
            <ul className="space-y-2">
              {DIALECTS.map((d: Dialect) => (
                <li
                  key={d}
                  className="rounded border border-ink-800/60 bg-ink-900/20 px-3 py-2"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="font-mono text-[10px] uppercase text-ink-500">
                      {DIALECT_LABELS[d]}
                    </div>
                    <CopyButton text={dialectOutputs[d]} label="copy" />
                  </div>
                  <div className="mt-1 break-words font-mono text-xs text-ink-200">
                    {dialectOutputs[d] || '(empty)'}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
      </div>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch (err) {
      console.error('clipboard write failed', err);
    }
  }, [text]);
  return (
    <button
      onClick={copy}
      disabled={!text}
      className="shrink-0 rounded border border-ink-800 px-2 py-0.5 font-mono text-[10px] text-ink-400 hover:bg-ink-800 disabled:opacity-40"
    >
      {copied ? 'copied' : label}
    </button>
  );
}

// A generated prompt plus one-click copy in each model dialect. The prompt is
// treated as the dialect "subject" with no modifiers -- these Phase 2 features
// produce whole prompts, not skeleton+dice canonicals.
function PromptResult({ prompt }: { prompt: string }) {
  const outputs = useMemo(() => toAllDialects({ subject: prompt, modifiers: [] }), [prompt]);
  return (
    <div className="space-y-2 rounded border border-ink-800/60 bg-ink-900/30 px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <p className="font-display text-base text-ink-100">{prompt}</p>
        <CopyButton text={prompt} label="copy" />
      </div>
      <div className="flex flex-wrap gap-1">
        {DIALECTS.map((d: Dialect) => (
          <CopyButton key={d} text={outputs[d]} label={DIALECT_LABELS[d]} />
        ))}
      </div>
    </div>
  );
}

function PromptList({
  prompts,
  loading,
  warning,
  empty
}: {
  prompts: string[];
  loading: boolean;
  warning: string | null;
  empty: string;
}) {
  if (warning) return <p className="font-mono text-xs text-amber-400">{warning}</p>;
  if (loading && prompts.length === 0)
    return <p className="font-mono text-xs text-ink-500">generating...</p>;
  if (prompts.length === 0) return <p className="font-mono text-xs text-ink-500">{empty}</p>;
  return (
    <ul className="space-y-2">
      {prompts.map((p, i) => (
        <li key={i}>
          <PromptResult prompt={p} />
        </li>
      ))}
    </ul>
  );
}

function EqualizerPanel({ axes }: { axes: VibeAxisOption[] }) {
  const [values, setValues] = useState<Record<string, number>>(() =>
    Object.fromEntries(axes.map((a) => [a.key, 0.5]))
  );
  const [prompts, setPrompts] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  // Don't fire a model call on mount; only after the owner touches a slider or
  // hits regenerate. Auto-regen is debounced 500ms so dragging a slider does
  // not spray requests.
  const touched = useRef(false);

  const generate = useCallback(async () => {
    setLoading(true);
    setWarning(null);
    try {
      const url = new URL('/api/admin/play/equalizer', window.location.origin);
      for (const [k, v] of Object.entries(values)) url.searchParams.set(k, v.toFixed(2));
      const res = await fetch(url, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'failed');
      setPrompts(data.prompts ?? []);
      if (data.warning) setWarning(data.warning);
    } catch (err) {
      console.error(err);
      setWarning('generation failed.');
    } finally {
      setLoading(false);
    }
  }, [values]);

  useEffect(() => {
    if (!touched.current || axes.length === 0) return;
    const id = setTimeout(generate, 500);
    return () => clearTimeout(id);
  }, [values, generate, axes.length]);

  if (axes.length === 0) {
    return (
      <section className="space-y-3">
        <h2 className="font-mono text-sm uppercase tracking-wider text-ink-300">equalizer</h2>
        <p className="font-mono text-xs text-amber-400">
          no vibe axes defined yet. run
          <code className="mx-1 rounded bg-ink-900 px-1 py-0.5 text-ink-100">
            bun scripts/vibe-axes.ts
          </code>
          to compare approaches, then
          <code className="mx-1 rounded bg-ink-900 px-1 py-0.5 text-ink-100">--write &lt;approach&gt;</code>
          to persist them, and reload.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-mono text-sm uppercase tracking-wider text-ink-300">equalizer</h2>
        <button
          onClick={generate}
          disabled={loading}
          className="rounded border border-ink-700 px-3 py-1 font-mono text-xs text-ink-100 hover:bg-ink-800 disabled:opacity-40"
        >
          {loading ? 'generating...' : 'reroll'}
        </button>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {axes.map((a) => (
          <label key={a.key} className="block space-y-1">
            <span className="flex items-center justify-between font-mono text-[11px] text-ink-300">
              <span>{a.label}</span>
              <span className="text-ink-500">{(values[a.key] ?? 0.5).toFixed(2)}</span>
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={values[a.key] ?? 0.5}
              onChange={(e) => {
                touched.current = true;
                const v = Number(e.target.value);
                setValues((prev) => ({ ...prev, [a.key]: v }));
              }}
              className="w-full accent-ink-300"
            />
            <span className="flex justify-between font-mono text-[9px] uppercase text-ink-600">
              <span>{a.negativePole}</span>
              <span>{a.positivePole}</span>
            </span>
          </label>
        ))}
      </div>
      <PromptList
        prompts={prompts}
        loading={loading}
        warning={warning}
        empty="move a slider or hit reroll to steer a prompt."
      />
    </section>
  );
}

function SurprisePanel() {
  const [prompts, setPrompts] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);

  const surprise = useCallback(async () => {
    setLoading(true);
    setWarning(null);
    try {
      const res = await fetch('/api/admin/play/surprise', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'failed');
      setPrompts(data.prompts ?? []);
      if (data.warning) setWarning(data.warning);
    } catch (err) {
      console.error(err);
      setWarning('generation failed.');
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-mono text-sm uppercase tracking-wider text-ink-300">surprise</h2>
        <button
          onClick={surprise}
          disabled={loading}
          className="rounded border border-ink-700 px-3 py-1 font-mono text-xs text-ink-100 hover:bg-ink-800 disabled:opacity-40"
        >
          {loading ? 'thinking...' : 'surprise me'}
        </button>
      </div>
      <p className="font-mono text-xs text-ink-500">
        prompts aimed at the empty space -- away from everything the gallery already is.
      </p>
      <PromptList
        prompts={prompts}
        loading={loading}
        warning={warning}
        empty="hit surprise me for prompts unlike anything in the gallery."
      />
    </section>
  );
}

type SeedThumb = { slug: string; blobUrl: string; caption: string };

function WalkPanel() {
  const [seeds, setSeeds] = useState<SeedThumb[]>([]);
  const [seedSlug, setSeedSlug] = useState<string | null>(null);
  const [steps, setSteps] = useState(5);
  const [temperature, setTemperature] = useState(0.5);
  const [path, setPath] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/images?limit=24', { cache: 'no-store' });
        const data = await res.json();
        if (!alive) return;
        const list: SeedThumb[] = (data.images ?? []).map((img: { slug: string; blobUrl: string; captions?: { text: string }[] }) => ({
          slug: img.slug,
          blobUrl: img.blobUrl,
          caption: img.captions?.[0]?.text ?? img.slug
        }));
        setSeeds(list);
      } catch (err) {
        console.error(err);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const walk = useCallback(async () => {
    if (!seedSlug) return;
    setLoading(true);
    setWarning(null);
    try {
      const url = new URL('/api/admin/play/walk', window.location.origin);
      url.searchParams.set('seed', seedSlug);
      url.searchParams.set('steps', String(steps));
      url.searchParams.set('temperature', temperature.toFixed(2));
      const res = await fetch(url, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'failed');
      setPath(data.steps ?? []);
      setCursor(0);
      if (data.warning) setWarning(data.warning);
    } catch (err) {
      console.error(err);
      setWarning('walk failed.');
    } finally {
      setLoading(false);
    }
  }, [seedSlug, steps, temperature]);

  return (
    <section className="space-y-4">
      <h2 className="font-mono text-sm uppercase tracking-wider text-ink-300">latent walk</h2>
      <p className="font-mono text-xs text-ink-500">
        pick a seed image and drift away from it, one prompt at a time. the embedding framing is
        metaphorical -- the model narrates the journey.
      </p>

      <div className="flex gap-2 overflow-x-auto pb-2">
        {seeds.map((s) => (
          <button
            key={s.slug}
            onClick={() => setSeedSlug(s.slug)}
            title={s.caption}
            className={`shrink-0 overflow-hidden rounded border ${
              seedSlug === s.slug ? 'border-ink-300' : 'border-ink-800 hover:border-ink-600'
            }`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- tiny seed-picker thumbnail */}
            <img src={s.blobUrl} alt={s.caption} loading="lazy" className="h-16 w-16 object-cover" />
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <label className="space-y-1">
          <span className="block font-mono text-[11px] text-ink-300">steps ({steps})</span>
          <input
            type="range"
            min={1}
            max={8}
            step={1}
            value={steps}
            onChange={(e) => setSteps(Number(e.target.value))}
            className="w-32 accent-ink-300"
          />
        </label>
        <label className="space-y-1">
          <span className="block font-mono text-[11px] text-ink-300">
            temperature ({temperature.toFixed(2)})
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={temperature}
            onChange={(e) => setTemperature(Number(e.target.value))}
            className="w-32 accent-ink-300"
          />
        </label>
        <button
          onClick={walk}
          disabled={!seedSlug || loading}
          className="rounded border border-ink-700 px-3 py-1 font-mono text-xs text-ink-100 hover:bg-ink-800 disabled:opacity-40"
        >
          {loading ? 'walking...' : 'walk'}
        </button>
      </div>

      {warning && <p className="font-mono text-xs text-amber-400">{warning}</p>}

      {path.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <span className="font-mono text-[11px] text-ink-500">
              step {cursor + 1} / {path.length}
            </span>
            <input
              type="range"
              min={0}
              max={path.length - 1}
              step={1}
              value={cursor}
              onChange={(e) => setCursor(Number(e.target.value))}
              className="flex-1 accent-ink-300"
            />
          </div>
          <PromptResult prompt={path[cursor] ?? ''} />
        </div>
      )}
    </section>
  );
}

function HaikuPanel() {
  const [haiku, setHaiku] = useState('');
  const [prompts, setPrompts] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);

  const generate = useCallback(async () => {
    if (!haiku.trim()) return;
    setLoading(true);
    setWarning(null);
    try {
      const res = await fetch('/api/admin/play/reverse-haiku', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ haiku })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'failed');
      setPrompts(data.prompts ?? []);
      if (data.warning) setWarning(data.warning);
    } catch (err) {
      console.error(err);
      setWarning('generation failed.');
    } finally {
      setLoading(false);
    }
  }, [haiku]);

  return (
    <section className="space-y-4">
      <h2 className="font-mono text-sm uppercase tracking-wider text-ink-300">reverse haiku</h2>
      <p className="font-mono text-xs text-ink-500">
        give a haiku, get prompts for an image it could caption.
      </p>
      <textarea
        value={haiku}
        onChange={(e) => setHaiku(e.target.value)}
        rows={3}
        placeholder={'an old silent pond\na frog jumps into the pond\nsplash, silence again'}
        className="w-full rounded border border-ink-800 bg-ink-950 px-3 py-2 font-mono text-sm text-ink-100"
      />
      <button
        onClick={generate}
        disabled={!haiku.trim() || loading}
        className="rounded border border-ink-700 px-3 py-1 font-mono text-xs text-ink-100 hover:bg-ink-800 disabled:opacity-40"
      >
        {loading ? 'generating...' : 'generate'}
      </button>
      <PromptList
        prompts={prompts}
        loading={loading}
        warning={warning}
        empty="enter a haiku and generate."
      />
    </section>
  );
}
