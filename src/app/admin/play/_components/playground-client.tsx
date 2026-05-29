'use client';

import { useCallback, useMemo, useState } from 'react';
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

const DEFAULT_N_SKELETONS = 6;
const DEFAULT_N_DICE = 3;

export function PlaygroundClient({
  grammarReady,
  categories,
  cardCounts
}: {
  grammarReady: boolean;
  categories: string[];
  cardCounts: Record<string, number>;
}) {
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
    <div className="space-y-10">
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
