'use client';

import { useState, useTransition } from 'react';

// Belt-and-suspenders: the API route self-gates with isSiteAdmin; a non-admin
// who hand-types this URL can render the page but every POST returns 403.

// feat/hud: admin trigger for the batch NSFW scan. Modeled on
// /admin/reprocess/page.tsx. Scan-all confirms first (it spends one Haiku
// vision call per image). A gallery multi-select to populate imageIds is
// deferred (see the gate report); the API already accepts imageIds, so the UI
// can grow into it without an API change.
export default function AdminScanNsfwPage() {
  const [result, setResult] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function scanAll() {
    const ok = confirm(
      'scanning ALL images will run the Haiku nudity classifier on every image and spend API credit. it updates only the NSFW flag (never tags/captions) and never overrides a manual flag. continue?'
    );
    if (!ok) return;
    setResult(null);
    startTransition(async () => {
      const res = await fetch('/api/admin/scan-nsfw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'all' })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setResult(`enqueued ${data.enqueued} scan job(s) for ${data.imageCount} image(s)`);
      } else {
        setResult(`error: ${data.error ?? 'failed'}`);
      }
    });
  }

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="font-display text-3xl text-ink-100">scan nsfw</h1>
      <p className="font-mono text-xs text-ink-500">
        re-classify nudity across the gallery with a Haiku-pinned vision pass. each image
        gets one cheap classification; the result updates ONLY the NSFW flag (auto source).
        a manual NSFW override is never clobbered, and tags/captions/embeddings are left
        untouched.
      </p>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={scanAll}
          disabled={isPending}
          className="rounded border border-destructive/50 bg-destructive/10 px-3 py-1.5 font-mono text-xs text-destructive hover:bg-destructive/20 disabled:opacity-50"
        >
          {isPending ? 'enqueuing...' : 'scan all images'}
        </button>
      </div>

      {result ? <p className="font-mono text-xs text-ink-300">{result}</p> : null}
      <p className="font-mono text-xs text-ink-500">
        jobs are drained by the cron at /api/cron/jobs; monitor progress on the jobs page
        (/admin/jobs).
      </p>
    </div>
  );
}
