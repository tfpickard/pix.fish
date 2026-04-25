import type { ProvenanceEntry } from '@/lib/db/queries/provenance';

// Collapsed details panel showing which model wrote each field. Lives at
// the bottom of an image detail page so prompt-curious visitors can see
// the trail without it dominating the layout.
export function ProvenancePanel({ entries }: { entries: ProvenanceEntry[] }) {
  const visible = entries.filter((e) => e.count > 0);
  if (visible.length === 0) return null;
  return (
    <details className="mx-auto max-w-2xl rounded border border-ink-800/60 bg-ink-950/40 px-4 py-2 font-mono text-xs text-ink-500">
      <summary className="cursor-pointer select-none uppercase tracking-wider transition-colors hover:text-ink-300">
        provenance
      </summary>
      <ul className="mt-3 space-y-1">
        {visible.map((e) => (
          <li key={e.field} className="flex flex-wrap items-baseline gap-x-2">
            <span className="w-24 shrink-0 uppercase tracking-wider text-ink-500">
              {e.field}
            </span>
            <span className="text-ink-300">
              {formatProvider(e)}
            </span>
            <span className="text-ink-500">&middot; {e.count}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function formatProvider(e: ProvenanceEntry): string {
  if (e.provider && e.model) return `${e.provider}/${e.model}`;
  if (e.provider) return e.provider;
  if (e.model) return e.model;
  return 'manual';
}
