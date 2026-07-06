'use client';

import { useCallback, useEffect, useState } from 'react';

// Admin-only eval labeling: turns the checkmark/X grading workflow into ground
// truth for scripts/eval-characters.ts. Labels are keyed by a stable, editable
// subjectLabel (default = the character's current name) so they survive
// re-clustering -- reuse the SAME label for the same real subject across runs.

type Appearance = { imageId: number; cropUrl: string | null };
type Verdict = boolean | null;

export default function CharacterLabeler({
  subjectDefault,
  appearances
}: {
  subjectDefault: string;
  appearances: Appearance[];
}) {
  const [subject, setSubject] = useState(subjectDefault);
  const [verdicts, setVerdicts] = useState<Record<number, Verdict>>({});
  const [status, setStatus] = useState<string>('');

  const load = useCallback(async (subj: string) => {
    if (!subj.trim()) return;
    try {
      const res = await fetch(`/api/admin/characters/labels?subject=${encodeURIComponent(subj)}`);
      if (!res.ok) return;
      const { labels } = (await res.json()) as { labels: { imageId: number; verdict: boolean }[] };
      const next: Record<number, Verdict> = {};
      for (const l of labels) next[l.imageId] = l.verdict;
      setVerdicts(next);
    } catch {
      // ignore -- labeling is best-effort tooling
    }
  }, []);

  useEffect(() => {
    // Reset the field to the new page's default too: on a client-side nav React
    // may preserve this component instance, so the useState initializer won't
    // re-run -- without this, saves for character B would land under A's label.
    setSubject(subjectDefault);
    load(subjectDefault);
  }, [subjectDefault, load]);

  async function setVerdict(imageId: number, verdict: Verdict) {
    // Clicking the active verdict again clears it.
    const next = verdicts[imageId] === verdict ? null : verdict;
    setVerdicts((v) => ({ ...v, [imageId]: next }));
    setStatus('saving...');
    try {
      const res = await fetch('/api/admin/characters/labels', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subjectLabel: subject, imageId, verdict: next })
      });
      setStatus(res.ok ? 'saved' : 'save failed');
    } catch {
      setStatus('save failed');
    }
  }

  return (
    <section className="space-y-3 rounded border border-dashed border-ink-800 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-mono text-xs uppercase tracking-wide text-ink-400">eval labeling</h2>
        <span className="font-mono text-[10px] text-ink-600">{status}</span>
      </div>
      <label className="block space-y-1">
        <span className="font-mono text-[10px] text-ink-600">
          subject label (stable key -- reuse the same one for this subject across re-clusters)
        </span>
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          onBlur={() => load(subject)}
          className="w-full rounded border border-ink-700 bg-ink-900/40 px-2 py-1 font-mono text-xs text-ink-100"
        />
      </label>
      <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4">
        {appearances.map((a) => {
          const v = verdicts[a.imageId] ?? null;
          return (
            <li key={a.imageId} className="space-y-1">
              <div className="aspect-square overflow-hidden rounded border border-ink-800/60 bg-ink-900/30">
                {a.cropUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={a.cropUrl} alt={`specimen ${a.imageId}`} className="h-full w-full object-cover" />
                ) : null}
              </div>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => setVerdict(a.imageId, true)}
                  className={`flex-1 rounded border px-1 py-0.5 font-mono text-xs ${
                    v === true
                      ? 'border-emerald-500 bg-emerald-500/20 text-emerald-300'
                      : 'border-ink-700 text-ink-500 hover:text-ink-200'
                  }`}
                >
                  ✓
                </button>
                <button
                  type="button"
                  onClick={() => setVerdict(a.imageId, false)}
                  className={`flex-1 rounded border px-1 py-0.5 font-mono text-xs ${
                    v === false
                      ? 'border-rose-500 bg-rose-500/20 text-rose-300'
                      : 'border-ink-700 text-ink-500 hover:text-ink-200'
                  }`}
                >
                  ✗
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
