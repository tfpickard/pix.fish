'use client';

import { useEffect, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

type ImageRecord = {
  slug: string;
  blobUrl: string;
  captions: { variant: number; text: string }[];
  descriptions: { variant: number; text: string }[];
  tags: { tag: string; source: string }[];
};

export function UploadZone() {
  const [file, setFile] = useState<File | null>(null);
  const [manualCaption, setManualCaption] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImageRecord | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Create the preview URL once per file and revoke it on change/unmount so we
  // don't leak blob: URLs across multiple selections.
  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      inputRef.current?.click();
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragActive(false);
    const f = e.dataTransfer.files?.[0];
    if (f) {
      setFile(f);
      setResult(null);
      setError(null);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    setSubmitting(true);
    setError(null);
    setResult(null);

    try {
      const fd = new FormData();
      fd.append('file', file);
      if (manualCaption.trim()) fd.append('manual_caption', manualCaption.trim());
      const res = await fetch('/api/images', { method: 'POST', body: fd });
      // The server should always return JSON, but an unhandled throw in the
      // route (or an upstream proxy error) can produce an HTML/plain-text body.
      // Read as text so a parse failure surfaces the real status instead of
      // WebKit's generic "did not match the expected pattern" SyntaxError.
      const raw = await res.text();
      let payload: { error?: string; message?: string; image?: ImageRecord } | null = null;
      try {
        payload = raw ? JSON.parse(raw) : null;
      } catch {
        payload = null;
      }
      if (!res.ok) {
        const snippet = raw.slice(0, 200) || '<empty body>';
        setError(payload?.error || payload?.message || `upload failed (${res.status}): ${snippet}`);
      } else if (payload?.image) {
        setResult(payload.image);
        setFile(null);
        setManualCaption('');
        if (inputRef.current) inputRef.current.value = '';
      } else {
        setError(`unexpected response (${res.status}): ${raw.slice(0, 200) || '<empty body>'}`);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={onSubmit} className="space-y-4">
        <div
          role="button"
          tabIndex={0}
          aria-label="upload an image; click or press enter to browse, or drop a file"
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          onKeyDown={onKeyDown}
          className={`flex h-52 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-400 ${
            dragActive ? 'border-ink-200 bg-ink-800/40' : 'border-ink-700 bg-ink-900/20'
          } text-center transition`}
        >
          {previewUrl ? (
            <img
              src={previewUrl}
              alt="preview"
              className="max-h-44 rounded object-contain"
            />
          ) : (
            <>
              <p className="font-display text-lg text-ink-200">drop a picture</p>
              <p className="mt-1 font-mono text-xs text-ink-500">
                or click to choose. jpeg/png/webp/gif up to ~20MB.
              </p>
            </>
          )}
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) {
                setFile(f);
                setResult(null);
                setError(null);
              }
            }}
            className="hidden"
          />
        </div>

        <div className="space-y-1.5">
          <label className="font-mono text-xs uppercase tracking-wider text-ink-500">
            manual caption (optional)
          </label>
          <Textarea
            value={manualCaption}
            onChange={(e) => setManualCaption(e.target.value)}
            placeholder="a soft hint for the AI, or your own canonical caption"
            rows={2}
          />
        </div>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={!file || submitting}>
            {submitting ? 'enriching...' : 'upload'}
          </Button>
          {submitting ? (
            <span className="font-mono text-xs text-ink-500">
              running captions x3, descriptions x3, tags. sit tight (15-40s).
            </span>
          ) : null}
        </div>
      </form>

      {error ? (
        <p className="rounded-md border border-red-900/50 bg-red-950/30 p-3 font-mono text-xs text-red-300">
          {error}
        </p>
      ) : null}

      {result ? (
        <section className="space-y-5 rounded-md border border-ink-800 bg-ink-900/30 p-4">
          <div className="flex items-start gap-4">
            <img src={result.blobUrl} alt={result.slug} className="h-24 w-24 rounded object-cover" />
            <div className="space-y-1">
              <p className="font-mono text-xs text-ink-500">slug</p>
              <a href={`/${result.slug}`} className="font-mono text-sm text-ink-100 hover:underline">
                /{result.slug}
              </a>
            </div>
          </div>
          <div>
            <p className="mb-1 font-mono text-xs uppercase tracking-wider text-ink-500">captions</p>
            <ul className="space-y-1 prose-caption text-ink-100">
              {result.captions.map((c) => (
                <li key={c.variant}>
                  <span className="mr-2 font-mono text-xs text-ink-500">v{c.variant}</span>
                  {c.text}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="mb-1 font-mono text-xs uppercase tracking-wider text-ink-500">
              descriptions
            </p>
            <ul className="space-y-2 prose-caption text-ink-200">
              {result.descriptions.map((d) => (
                <li key={d.variant}>
                  <span className="mr-2 font-mono text-xs text-ink-500">v{d.variant}</span>
                  {d.text}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="mb-1 font-mono text-xs uppercase tracking-wider text-ink-500">tags</p>
            <div className="flex flex-wrap gap-1">
              {result.tags.map((t) => (
                <span
                  key={t.tag}
                  className={`chip ${t.source === 'taxonomy' ? 'border-ink-500 text-ink-200' : ''}`}
                  title={t.source}
                >
                  {t.tag}
                </span>
              ))}
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
