'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent
} from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

type HydratedImage = {
  id: number;
  slug: string;
  blobUrl: string;
  captions: { variant: number; text: string }[];
};

type RowStatus = 'pending' | 'uploading' | 'queued' | 'enriched' | 'failed';

type FileRow = {
  key: string;
  file: File;
  previewUrl: string;
  status: RowStatus;
  imageId?: number;
  slug?: string;
  caption?: string;
  error?: string;
};

// Parallel upload fan-out. Four keeps us well under Vercel's concurrent
// function-invocation soft cap while finishing a 20-file drop in ~5 batches.
const UPLOAD_CONCURRENCY = 4;
const POLL_INTERVAL_MS = 3_000;

export function UploadZone() {
  const [rows, setRows] = useState<FileRow[]>([]);
  const [manualCaption, setManualCaption] = useState('');
  const [manualDescription, setManualDescription] = useState('');
  const [manualTags, setManualTags] = useState('');
  const [manualNsfw, setManualNsfw] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Revoke preview object URLs when rows are cleared to avoid leaking memory
  // across multiple selection cycles.
  useEffect(() => {
    return () => {
      for (const r of rows) URL.revokeObjectURL(r.previewUrl);
    };
    // only run on unmount; per-row cleanup happens in clearRows below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearRows = useCallback(() => {
    setRows((prev) => {
      for (const r of prev) URL.revokeObjectURL(r.previewUrl);
      return [];
    });
    if (inputRef.current) inputRef.current.value = '';
  }, []);

  function addFiles(list: FileList | File[] | null) {
    if (!list) return;
    const files = Array.from(list);
    if (files.length === 0) return;
    setFormError(null);
    setRows((prev) => [
      ...prev,
      ...files.map<FileRow>((file) => ({
        key: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        previewUrl: URL.createObjectURL(file),
        status: 'pending'
      }))
    ]);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      inputRef.current?.click();
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragActive(false);
    addFiles(e.dataTransfer.files);
  }

  function onInputChange(e: ChangeEvent<HTMLInputElement>) {
    addFiles(e.target.files);
    // Reset input value so re-selecting the same file still fires onChange.
    e.target.value = '';
  }

  function removeRow(key: string) {
    setRows((prev) => {
      const target = prev.find((r) => r.key === key);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((r) => r.key !== key);
    });
  }

  async function uploadOne(
    row: FileRow,
    shared: {
      manualCaption?: string;
      manualDescription?: string;
      manualTags?: string;
      manualNsfw: boolean;
    }
  ) {
    setRows((prev) =>
      prev.map((r) => (r.key === row.key ? { ...r, status: 'uploading', error: undefined } : r))
    );
    try {
      const fd = new FormData();
      fd.append('file', row.file);
      if (shared.manualCaption) fd.append('manual_caption', shared.manualCaption);
      if (shared.manualDescription) fd.append('manual_description', shared.manualDescription);
      if (shared.manualTags) fd.append('manual_tags', shared.manualTags);
      if (shared.manualNsfw) fd.append('manual_nsfw', 'true');
      const res = await fetch('/api/images', { method: 'POST', body: fd });
      const raw = await res.text();
      let payload:
        | { error?: string; message?: string; image?: { id: number; slug: string; blobUrl: string } }
        | null = null;
      try {
        payload = raw ? JSON.parse(raw) : null;
      } catch {
        payload = null;
      }
      // 202 = queued; 201 kept for forward compat if the server changes.
      if ((res.status === 201 || res.status === 202) && payload?.image) {
        setRows((prev) =>
          prev.map((r) =>
            r.key === row.key
              ? {
                  ...r,
                  status: 'queued',
                  imageId: payload!.image!.id,
                  slug: payload!.image!.slug,
                  error: undefined
                }
              : r
          )
        );
        return;
      }
      const snippet = raw.slice(0, 200) || '<empty body>';
      const msg = payload?.error || payload?.message || `upload failed (${res.status}): ${snippet}`;
      setRows((prev) =>
        prev.map((r) => (r.key === row.key ? { ...r, status: 'failed', error: msg } : r))
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setRows((prev) =>
        prev.map((r) => (r.key === row.key ? { ...r, status: 'failed', error: msg } : r))
      );
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const pending = rows.filter((r) => r.status === 'pending');
    if (pending.length === 0) return;
    setSubmitting(true);
    setFormError(null);
    const shared = {
      manualCaption: manualCaption.trim() || undefined,
      manualDescription: manualDescription.trim() || undefined,
      manualTags: manualTags.trim() || undefined,
      manualNsfw
    };

    // Cap concurrent uploads; a single shared index ensures fairness when
    // rows are added mid-upload (future-proofing, not used today).
    let cursor = 0;
    async function worker() {
      while (cursor < pending.length) {
        const idx = cursor++;
        if (idx >= pending.length) return;
        await uploadOne(pending[idx], shared);
      }
    }
    const workers = Array.from({ length: Math.min(UPLOAD_CONCURRENCY, pending.length) }, worker);
    await Promise.all(workers);

    setSubmitting(false);
    // Leave manualCaption in place so repeated drops can reuse it; clear only
    // on explicit reset via "clear all".
  }

  // Poll for enrichment progress on any image that's been queued.
  useEffect(() => {
    const queuedIds = rows
      .filter((r) => r.status === 'queued' && typeof r.imageId === 'number')
      .map((r) => r.imageId as number);
    if (queuedIds.length === 0) return;

    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/images?ids=${queuedIds.join(',')}`, { cache: 'no-store' });
        if (!res.ok) return;
        const body: { images?: HydratedImage[] } = await res.json();
        const byId = new Map((body.images ?? []).map((img) => [img.id, img] as const));
        if (cancelled) return;
        setRows((prev) =>
          prev.map((r) => {
            if (r.status !== 'queued' || !r.imageId) return r;
            const img = byId.get(r.imageId);
            if (!img) return r;
            const firstCaption = img.captions[0]?.text;
            // captions.length > 0 is the signal that enrich.image committed.
            if (img.captions.length > 0) {
              return {
                ...r,
                status: 'enriched',
                slug: img.slug,
                caption: firstCaption
              };
            }
            return r;
          })
        );
      } catch {
        // Transient fetch failure -- next tick will retry.
      }
    };

    const handle = window.setInterval(tick, POLL_INTERVAL_MS);
    // Run once immediately so the UI updates faster after the last upload
    // resolves to queued.
    tick();
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [rows]);

  const pendingCount = rows.filter((r) => r.status === 'pending').length;
  const uploadingCount = rows.filter((r) => r.status === 'uploading').length;
  const queuedCount = rows.filter((r) => r.status === 'queued').length;
  const enrichedCount = rows.filter((r) => r.status === 'enriched').length;
  const failedCount = rows.filter((r) => r.status === 'failed').length;

  return (
    <div className="space-y-6">
      <form onSubmit={onSubmit} className="space-y-4">
        <div
          role="button"
          tabIndex={0}
          aria-label="upload images; click or press enter to browse, or drop files"
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          onKeyDown={onKeyDown}
          className={`flex h-44 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-400 ${
            dragActive ? 'border-ink-200 bg-ink-800/40' : 'border-ink-700 bg-ink-900/20'
          } text-center transition`}
        >
          <p className="font-display text-lg text-ink-200">drop pictures</p>
          <p className="mt-1 font-mono text-xs text-ink-500">
            or click to choose. jpeg/png/webp/gif up to ~20MB each. multiple files ok.
          </p>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp,image/gif"
            onChange={onInputChange}
            className="hidden"
          />
        </div>

        <div className="space-y-1.5">
          <label className="font-mono text-xs uppercase tracking-wider text-ink-500">
            manual caption (optional, applied to every file in this batch)
          </label>
          <Textarea
            value={manualCaption}
            onChange={(e) => setManualCaption(e.target.value)}
            placeholder="a soft hint for the AI, or your own canonical caption"
            rows={2}
          />
          <p className="font-mono text-xs text-ink-500">
            without an AI key, manual caption + manual tags below become the only text on the image.
          </p>
        </div>

        <div className="space-y-1.5">
          <label className="font-mono text-xs uppercase tracking-wider text-ink-500">
            manual description (optional)
          </label>
          <Textarea
            value={manualDescription}
            onChange={(e) => setManualDescription(e.target.value)}
            placeholder="a longer note. only applied if you have no AI key, or if you want a locked description alongside the AI variants."
            rows={2}
          />
        </div>

        <div className="space-y-1.5">
          <label className="font-mono text-xs uppercase tracking-wider text-ink-500">
            manual tags (optional, comma-separated)
          </label>
          <input
            type="text"
            value={manualTags}
            onChange={(e) => setManualTags(e.target.value)}
            placeholder="film, sunset, fire-escape"
            className="w-full rounded-md border border-ink-800 bg-ink-950/60 px-3 py-1.5 font-mono text-sm text-ink-100 placeholder:text-ink-500 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
          />
        </div>

        <label className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-ink-500">
          <input
            type="checkbox"
            checked={manualNsfw}
            onChange={(e) => setManualNsfw(e.target.checked)}
            className="h-4 w-4 accent-primary"
          />
          mark as nsfw
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pendingCount === 0 || submitting}>
            {submitting
              ? `uploading... (${uploadingCount + queuedCount + enrichedCount}/${rows.length})`
              : pendingCount > 0
                ? `upload ${pendingCount} ${pendingCount === 1 ? 'file' : 'files'}`
                : 'upload'}
          </Button>
          {rows.length > 0 ? (
            <Button type="button" variant="outline" onClick={clearRows} disabled={submitting}>
              clear all
            </Button>
          ) : null}
          {rows.length > 0 ? (
            <span className="font-mono text-xs text-ink-500">
              {enrichedCount} enriched / {queuedCount} queued / {uploadingCount} uploading
              {failedCount > 0 ? ` / ${failedCount} failed` : ''}
            </span>
          ) : null}
        </div>
        {queuedCount > 0 ? (
          <p className="font-mono text-xs text-ink-500">
            enrichment runs in the background. cron drains every minute; each image takes ~15-40s once picked up.{' '}
            <a href="/admin/jobs" className="underline">
              live job queue
            </a>
            .
          </p>
        ) : null}
      </form>

      {formError ? (
        <p className="rounded-md border border-red-900/50 bg-red-950/30 p-3 font-mono text-xs text-red-300">
          {formError}
        </p>
      ) : null}

      {rows.length > 0 ? (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li
              key={r.key}
              className="flex items-start gap-3 rounded-md border border-ink-800 bg-ink-900/30 p-3"
            >
              <img
                src={r.previewUrl}
                alt="preview"
                className="h-16 w-16 flex-shrink-0 rounded object-cover"
              />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-mono text-xs text-ink-300">{r.file.name}</span>
                  <StatusBadge status={r.status} />
                </div>
                {r.slug ? (
                  <a
                    href={`/${r.slug}`}
                    target="_blank"
                    rel="noreferrer"
                    className="block truncate font-mono text-xs text-ink-400 hover:underline"
                  >
                    /{r.slug}
                  </a>
                ) : null}
                {r.caption ? (
                  <p className="line-clamp-2 prose-caption text-sm text-ink-100">{r.caption}</p>
                ) : null}
                {r.error ? (
                  <p className="font-mono text-xs text-red-300">{r.error}</p>
                ) : null}
              </div>
              {r.status === 'pending' || r.status === 'failed' ? (
                <button
                  type="button"
                  onClick={() => removeRow(r.key)}
                  className="font-mono text-xs text-ink-500 hover:text-ink-200"
                  aria-label={`remove ${r.file.name}`}
                >
                  remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function StatusBadge({ status }: { status: RowStatus }) {
  const copy: Record<RowStatus, { label: string; className: string }> = {
    pending: { label: 'pending', className: 'border-ink-700 text-ink-400' },
    uploading: { label: 'uploading', className: 'border-ink-500 text-ink-200' },
    queued: { label: 'queued', className: 'border-ink-500 text-ink-200' },
    enriched: { label: 'enriched', className: 'border-emerald-700 text-emerald-300' },
    failed: { label: 'failed', className: 'border-red-800 text-red-300' }
  };
  const { label, className } = copy[status];
  return (
    <span
      className={`rounded-sm border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${className}`}
    >
      {label}
    </span>
  );
}
