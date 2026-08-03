'use client';

import { useEffect, useState, useTransition } from 'react';

type Row = { id: number; field: string; provider: string; model: string; updatedAt: string };
type RefRow = { feature: string; via?: string; model: string };
type Reference = { derived: RefRow[]; hardcoded: RefRow[] };
type Resolved = Record<string, { provider: string; model: string }>;

// Fields whose runtime uses inherit the `captions` routing until pinned.
const INHERIT_CAPTIONS = new Set(['detect', 'verify', 'dossier']);

// Providers the runtime actually honors per field (mirrors the PUT validation +
// loadAiConfig): chat is Anthropic-only; the pipeline is anthropic/openai;
// imagegen has its own set.
function providerOptions(field: string): readonly string[] {
  // dispatch-text.ts speaks Anthropic only, and the PUT schema rejects anything
  // else -- offering OpenAI here would submit a value the API refuses while save()
  // reloads without surfacing why.
  if (field === 'chat' || field === 'dispatch' || field === 'dispatchSafety')
    return ['anthropic'];
  if (field === 'imagegen') return ['anthropic', 'openai', 'openrouter', 'stub'];
  return ['anthropic', 'openai'];
}

const FIELDS = [
  'captions',
  'descriptions',
  'tags',
  'embeddings',
  'detect',
  'verify',
  'dossier',
  'nsfw',
  'chat',
  // Outbound X dispatch, split in two because the calls want opposite things.
  // 'dispatch' writes the caption (the deliverable -- a better tier earns its
  // cost here); 'dispatchSafety' is the trend classifier (mechanical JSON under
  // a tight deadline, so speed matters more than reasoning). Both Anthropic-only
  // -- src/lib/ai/dispatch-text.ts speaks no other provider and returns null,
  // skipping the day, if either row names one.
  'dispatch',
  'dispatchSafety',
  'imagegen'
] as const;
const PROVIDERS = ['anthropic', 'openai', 'openrouter', 'stub'] as const;

export default function AdminAiPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [reference, setReference] = useState<Reference | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Record<string, { provider: string; model: string }>>({});
  const [isPending, startTransition] = useTransition();

  function load() {
    fetch('/api/admin/ai-config')
      .then((r) => r.json())
      .then((data) => {
        setRows(data.rows ?? []);
        setReference(data.reference ?? null);
        const d: Record<string, { provider: string; model: string }> = {};
        // Prefill from the resolved (effective) config so inherited fields show
        // their real value; imagegen isn't in that map, so fall back to its row.
        const resolved: Resolved = data.resolved ?? {};
        for (const [field, cfg] of Object.entries(resolved)) {
          d[field] = { provider: cfg.provider, model: cfg.model };
        }
        for (const r of data.rows ?? []) if (!d[r.field]) d[r.field] = { provider: r.provider, model: r.model };
        setDraft(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }

  useEffect(load, []);

  function save(field: string) {
    const d = draft[field];
    if (!d) return;
    startTransition(async () => {
      await fetch('/api/admin/ai-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field, provider: d.provider, model: d.model })
      });
      load();
    });
  }

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="font-display text-3xl text-ink-100">ai config</h1>
      <p className="font-mono text-xs text-ink-500">
        per-field routing. changes take effect on the next request; reprocess existing
        rows from /admin/reprocess.
      </p>
      {loading ? (
        <p className="font-mono text-xs text-ink-500">loading...</p>
      ) : (
        <div className="space-y-3">
          {FIELDS.map((f) => {
            const d = draft[f] ?? { provider: 'anthropic', model: '' };
            const inherited = INHERIT_CAPTIONS.has(f) && !rows.some((r) => r.field === f);
            return (
              <div key={f} className="flex items-center gap-2 rounded border border-ink-800 p-3">
                <span className="flex w-28 flex-col font-mono text-xs text-ink-300">
                  {f}
                  {inherited && <span className="text-[10px] text-ink-500">inherits captions</span>}
                </span>
                <select
                  value={d.provider}
                  onChange={(e) =>
                    setDraft((p) => ({ ...p, [f]: { ...d, provider: e.target.value } }))
                  }
                  className="rounded border border-ink-800 bg-ink-950 px-2 py-1 font-mono text-xs text-ink-100"
                >
                  {providerOptions(f).map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  value={d.model}
                  onChange={(e) =>
                    setDraft((p) => ({ ...p, [f]: { ...d, model: e.target.value } }))
                  }
                  className="flex-1 rounded border border-ink-800 bg-ink-950 px-2 py-1 font-mono text-xs text-ink-100"
                />
                <button
                  type="button"
                  onClick={() => save(f)}
                  disabled={isPending}
                  className="rounded border border-primary/50 bg-primary/10 px-3 py-1 font-mono text-xs text-primary hover:bg-primary/20 disabled:opacity-50"
                >
                  save
                </button>
              </div>
            );
          })}
        </div>
      )}

      {reference && (
        <div className="space-y-4 border-t border-ink-800 pt-6">
          <div className="space-y-1">
            <h2 className="font-mono text-xs uppercase tracking-wider text-ink-300">
              other model uses (read-only)
            </h2>
            <p className="font-mono text-[11px] text-ink-500">
              these LLM call sites have no row of their own. selecting them independently is
              a follow-up; for now this just shows what each one runs.
            </p>
          </div>

          <div className="space-y-1">
            <p className="font-mono text-[11px] uppercase tracking-wider text-ink-500">
              follows a field above
            </p>
            {reference.derived.map((r) => (
              <div key={r.feature} className="flex items-baseline gap-2 font-mono text-xs">
                <span className="flex-1 text-ink-300">{r.feature}</span>
                <span className="text-ink-500">via {r.via}</span>
                <span className="text-ink-100">{r.model}</span>
              </div>
            ))}
          </div>

          <div className="space-y-1">
            <p className="font-mono text-[11px] uppercase tracking-wider text-ink-500">
              hardcoded (not yet configurable)
            </p>
            {reference.hardcoded.map((r) => (
              <div key={r.feature} className="flex items-baseline gap-2 font-mono text-xs">
                <span className="flex-1 text-ink-300">{r.feature}</span>
                <span className="text-ink-100">{r.model}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
