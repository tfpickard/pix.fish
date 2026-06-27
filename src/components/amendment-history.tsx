import type { Clerk, LoreFragment } from '@/lib/db/schema';

// The amendment history for a specimen: every signed fragment ever filed
// against it, newest first, each expandable so you can watch the file mutate
// over time. Read from the `lore_fragments` projection. In Phase 1 this is the
// single intake; the Phase 2 evolution loop appends amendments here, and
// contradictions between clerks are preserved -- never resolved or deduped.

export function AmendmentHistory({
  fragments,
  clerksBySlug
}: {
  fragments: LoreFragment[];
  clerksBySlug: Map<string, Clerk>;
}) {
  if (fragments.length === 0) return null;

  // Newest first so the latest filing leads; the rest is the paper trail.
  const ordered = [...fragments].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || b.id - a.id
  );

  return (
    <section
      aria-label="amendment history"
      className="mx-auto max-w-2xl space-y-3 border-t border-ink-800 pt-6 pb-8"
    >
      <h2 className="font-mono text-xs uppercase tracking-wide text-ink-500">
        amendment history{' '}
        <span className="text-ink-600">({fragments.length})</span>
      </h2>

      <ol className="space-y-2">
        {ordered.map((f, i) => {
          const clerk = clerksBySlug.get(f.clerkSlug);
          const when = new Date(f.createdAt).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
          });
          return (
            <li key={f.id}>
              <details open={i === 0} className="group rounded border border-ink-800/60 bg-ink-900/20">
                <summary className="flex cursor-pointer flex-wrap items-baseline justify-between gap-2 px-3 py-2 font-mono text-xs text-ink-400 marker:content-none">
                  <span>
                    <span className="text-ink-200">{clerk?.name ?? f.clerkSlug}</span>
                    {' '}
                    <span className="text-ink-600">&middot; {f.kind}</span>
                  </span>
                  <span className="text-ink-600">{when}</span>
                </summary>
                <div className="prose-caption whitespace-pre-line border-t border-ink-800/60 px-3 py-3 text-sm leading-relaxed text-ink-200">
                  {f.body}
                </div>
              </details>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
