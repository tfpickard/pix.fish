'use client';

import { useCallback, useMemo, useState } from 'react';
import { DIALECTS, DIALECT_LABELS, toAllDialects, type Dialect } from '@/lib/playground/dialects';

type Idiom = { key: string; label: string };

// Owner-only "remix this concept as..." menu. Keeps the concept, swaps the
// visual idiom, then offers the rewritten prompt in each model dialect.
export function RemixMenu({
  slug,
  imageId,
  idioms
}: {
  slug: string;
  imageId: number;
  idioms: Idiom[];
}) {
  const [open, setOpen] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);

  const remix = useCallback(
    async (idiomKey: string) => {
      setActiveKey(idiomKey);
      setLoading(true);
      setWarning(null);
      setPrompts([]);
      try {
        const res = await fetch(`/api/images/${encodeURIComponent(slug)}/remix`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ idiomKey, imageId })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error ?? 'failed');
        setPrompts(data.prompts ?? []);
        if (data.warning) setWarning(data.warning);
      } catch (err) {
        console.error(err);
        setWarning('remix failed.');
      } finally {
        setLoading(false);
      }
    },
    [slug, imageId]
  );

  if (idioms.length === 0) return null;

  return (
    <div className="flex flex-col items-center gap-3 border-t border-ink-800 pt-4">
      <button
        onClick={() => setOpen((v) => !v)}
        className="font-mono text-xs text-ink-400 hover:text-ink-100"
      >
        {open ? 'hide remix' : 'remix this concept as...'}
      </button>

      {open && (
        <div className="w-full space-y-3">
          <div className="flex flex-wrap justify-center gap-1">
            {idioms.map((idiom) => (
              <button
                key={idiom.key}
                onClick={() => remix(idiom.key)}
                disabled={loading}
                className={`rounded border px-2 py-0.5 font-mono text-[11px] disabled:opacity-40 ${
                  activeKey === idiom.key
                    ? 'border-ink-400 bg-ink-800 text-ink-100'
                    : 'border-ink-800 text-ink-400 hover:border-ink-600'
                }`}
              >
                {idiom.label}
              </button>
            ))}
          </div>

          {loading && <p className="text-center font-mono text-xs text-ink-500">remixing...</p>}
          {warning && <p className="text-center font-mono text-xs text-amber-400">{warning}</p>}

          <ul className="space-y-2">
            {prompts.map((p, i) => (
              <li key={i}>
                <RemixResult prompt={p} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function RemixResult({ prompt }: { prompt: string }) {
  const outputs = useMemo(() => toAllDialects({ subject: prompt, modifiers: [] }), [prompt]);
  return (
    <div className="space-y-2 rounded border border-ink-800/60 bg-ink-900/30 px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <p className="font-display text-sm text-ink-100">{prompt}</p>
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
