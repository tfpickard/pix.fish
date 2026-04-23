'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { Trash2 } from 'lucide-react';
import { compose, type Family } from '@/lib/prompts/compose';
import { voices, lengths, audiences, extras } from '@/lib/prompts/fragments';

type SavedPrompt = {
  id: number;
  name: string;
  key: string;
  template: string;
  fragments: {
    voice?: keyof typeof voices;
    length?: keyof typeof lengths;
    audience?: keyof typeof audiences;
    extras?: (keyof typeof extras)[];
  } | null;
  updatedAt: string;
};

const FAMILIES: Family[] = ['caption', 'description', 'tags'];

export default function AdminSavedPromptsPage() {
  const [rows, setRows] = useState<SavedPrompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [family, setFamily] = useState<Family>('caption');
  const [voice, setVoice] = useState<keyof typeof voices | ''>('poetic');
  const [length, setLength] = useState<keyof typeof lengths | ''>('short');
  const [audience, setAudience] = useState<keyof typeof audiences | ''>('general');
  const [picked, setPicked] = useState<(keyof typeof extras)[]>([]);
  const [isPending, startTransition] = useTransition();
  const [info, setInfo] = useState<string | null>(null);

  function load() {
    fetch('/api/admin/saved-prompts')
      .then((r) => r.json())
      .then((data) => {
        setRows(data.rows ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }

  useEffect(load, []);

  const preview = useMemo(
    () =>
      compose(family, {
        voice: voice || undefined,
        length: length || undefined,
        audience: audience || undefined,
        extras: picked
      }),
    [family, voice, length, audience, picked]
  );

  function toggleExtra(k: keyof typeof extras) {
    setPicked((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));
  }

  function save() {
    if (!name.trim()) return;
    setInfo(null);
    startTransition(async () => {
      const res = await fetch('/api/admin/saved-prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          key: family,
          template: preview,
          fragments: {
            voice: voice || undefined,
            length: length || undefined,
            audience: audience || undefined,
            extras: picked
          }
        })
      });
      if (res.ok) {
        setName('');
        load();
      } else {
        const data = await res.json().catch(() => ({}));
        setInfo(data.error ?? 'save failed');
      }
    });
  }

  async function remove(id: number) {
    await fetch(`/api/admin/saved-prompts/${id}`, { method: 'DELETE' });
    load();
  }

  async function promote(id: number) {
    const ok = confirm('promote will overwrite the active prompt for this key. continue?');
    if (!ok) return;
    setInfo(null);
    const res = await fetch(`/api/admin/saved-prompts/${id}/promote`, { method: 'POST' });
    if (res.ok) setInfo('promoted -- active prompt updated');
    else {
      const data = await res.json().catch(() => ({}));
      setInfo(`error: ${data.error ?? 'failed'}`);
    }
  }

  function loadInto(p: SavedPrompt) {
    setFamily(p.key as Family);
    const f = p.fragments;
    setVoice(f?.voice ?? '');
    setLength(f?.length ?? '');
    setAudience(f?.audience ?? '');
    setPicked(f?.extras ?? []);
    setName(p.name);
  }

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="font-display text-3xl text-ink-100">saved prompts</h1>
      <p className="font-mono text-xs text-ink-500">
        compose a prompt from fragments, save it, then promote to overwrite the active
        prompt for its key.
      </p>

      <section className="space-y-3 rounded-lg border border-ink-800 p-4">
        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="flex-1 rounded border border-ink-800 bg-ink-950 px-3 py-1.5 font-mono text-xs text-ink-100"
          />
          <select
            value={family}
            onChange={(e) => setFamily(e.target.value as Family)}
            className="rounded border border-ink-800 bg-ink-950 px-2 py-1.5 font-mono text-xs text-ink-100"
          >
            {FAMILIES.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <label className="font-mono text-xs text-ink-500">
            voice
            <select
              value={voice}
              onChange={(e) => setVoice(e.target.value as keyof typeof voices | '')}
              className="mt-1 w-full rounded border border-ink-800 bg-ink-950 px-2 py-1 text-ink-100"
            >
              <option value="">--</option>
              {Object.keys(voices).map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
          <label className="font-mono text-xs text-ink-500">
            length
            <select
              value={length}
              onChange={(e) => setLength(e.target.value as keyof typeof lengths | '')}
              className="mt-1 w-full rounded border border-ink-800 bg-ink-950 px-2 py-1 text-ink-100"
            >
              <option value="">--</option>
              {Object.keys(lengths).map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
          <label className="font-mono text-xs text-ink-500">
            audience
            <select
              value={audience}
              onChange={(e) => setAudience(e.target.value as keyof typeof audiences | '')}
              className="mt-1 w-full rounded border border-ink-800 bg-ink-950 px-2 py-1 text-ink-100"
            >
              <option value="">--</option>
              {Object.keys(audiences).map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
        </div>

        <div>
          <p className="font-mono text-xs text-ink-500 mb-1">extras</p>
          <div className="flex flex-wrap gap-3">
            {(Object.keys(extras) as (keyof typeof extras)[]).map((k) => (
              <label key={k} className="flex items-center gap-1 font-mono text-xs text-ink-300">
                <input type="checkbox" checked={picked.includes(k)} onChange={() => toggleExtra(k)} />
                {k}
              </label>
            ))}
          </div>
        </div>

        <pre className="max-h-56 overflow-auto rounded border border-ink-800 bg-ink-950 p-3 font-mono text-xs text-ink-300 whitespace-pre-wrap">
{preview}
        </pre>

        <button
          type="button"
          onClick={save}
          disabled={isPending || !name.trim()}
          className="rounded border border-primary/50 bg-primary/10 px-3 py-1.5 font-mono text-xs text-primary hover:bg-primary/20 disabled:opacity-50"
        >
          save
        </button>
        {info ? <p className="font-mono text-xs text-ink-400">{info}</p> : null}
      </section>

      <section className="space-y-2">
        <h2 className="font-mono text-xs text-ink-500">saved</h2>
        {loading ? (
          <p className="font-mono text-xs text-ink-500">loading...</p>
        ) : rows.length === 0 ? (
          <p className="font-mono text-xs text-ink-500">no saved prompts yet</p>
        ) : (
          rows.map((p) => (
            <div key={p.id} className="flex items-center gap-3 rounded border border-ink-800 p-3">
              <div className="min-w-0 flex-1">
                <p className="font-mono text-sm text-ink-100 truncate">{p.name}</p>
                <p className="font-mono text-xs text-ink-500">{p.key}</p>
              </div>
              <button
                type="button"
                onClick={() => loadInto(p)}
                className="font-mono text-xs text-ink-400 hover:text-ink-100"
              >
                load
              </button>
              <button
                type="button"
                onClick={() => promote(p.id)}
                className="rounded border border-secondary/50 bg-secondary/10 px-2 py-1 font-mono text-xs text-secondary hover:bg-secondary/20"
              >
                promote
              </button>
              <button
                type="button"
                onClick={() => remove(p.id)}
                className="text-ink-500 hover:text-destructive"
                aria-label="delete"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
