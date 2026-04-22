'use client';

import { useState, useRef, type DragEvent, type FormEvent } from 'react';
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
  const inputRef = useRef<HTMLInputElement>(null);

  const previewUrl = file ? URL.createObjectURL(file) : null;

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
      const payload = await res.json();
      if (!res.ok) {
        setError(payload.error || payload.message || 'upload failed');
      } else {
        setResult(payload.image as ImageRecord);
        setFile(null);
        setManualCaption('');
        if (inputRef.current) inputRef.current.value = '';
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
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          className={`flex h-52 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed ${
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
