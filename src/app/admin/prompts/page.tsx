'use client';

import { useState, useEffect, useTransition } from 'react';

type Prompt = {
  id: number;
  key: string;
  template: string;
  version: number;
  updatedAt: string;
};

const PLACEHOLDERS: Record<string, string[]> = {
  caption: ['{{existing_caption}}', '{{variant_number}}'],
  description: ['{{variant_number}}'],
  tags: ['{{tag_taxonomy}}', '{{existing_caption}}']
};

function PromptCard({ prompt, onSaved }: { prompt: Prompt; onSaved: (p: Prompt) => void }) {
  const [template, setTemplate] = useState(prompt.template);
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [errMsg, setErrMsg] = useState('');
  const [isPending, startTransition] = useTransition();

  function save() {
    startTransition(async () => {
      const res = await fetch(`/api/prompts/${prompt.key}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template })
      });
      if (res.ok) {
        const updated = await res.json();
        onSaved(updated);
        setStatus('saved');
        setTimeout(() => setStatus('idle'), 2000);
      } else {
        const data = await res.json().catch(() => ({}));
        setErrMsg(data.error ?? 'save failed');
        setStatus('error');
      }
    });
  }

  const hints = PLACEHOLDERS[prompt.key] ?? [];
  const isDirty = template !== prompt.template;

  return (
    <div className="space-y-3 rounded-lg border border-ink-800 bg-ink-900/30 p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="font-mono text-sm text-ink-100">{prompt.key}</h2>
        <span className="font-mono text-xs text-ink-500">v{prompt.version}</span>
      </div>

      {hints.length > 0 && (
        <p className="font-mono text-xs text-ink-500">
          placeholders:{' '}
          {hints.map((h) => (
            <code key={h} className="mr-2 text-accent">{h}</code>
          ))}
        </p>
      )}

      <textarea
        value={template}
        onChange={(e) => { setTemplate(e.target.value); setStatus('idle'); }}
        rows={10}
        className="w-full resize-y rounded border border-ink-800 bg-ink-950/60 px-3 py-2 font-mono text-xs leading-relaxed text-ink-100 placeholder:text-ink-500 focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/20"
      />

      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={save}
          disabled={isPending || !isDirty}
          className="font-mono text-xs uppercase tracking-wide text-primary transition-colors hover:text-primary/70 disabled:opacity-40"
        >
          {isPending ? 'saving...' : 'save prompt'}
        </button>
        {status === 'saved' && (
          <span className="font-mono text-xs text-secondary">saved</span>
        )}
        {status === 'error' && (
          <span className="font-mono text-xs text-destructive">{errMsg}</span>
        )}
        {isDirty && status === 'idle' && (
          <span className="font-mono text-xs text-ink-500">unsaved changes</span>
        )}
      </div>
    </div>
  );
}

export default function AdminPromptsPage() {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/prompts')
      .then((r) => r.json())
      .then((data) => { setPrompts(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  function onSaved(updated: Prompt) {
    setPrompts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="font-display text-2xl text-ink-100">prompts</h1>
        <p className="font-mono text-xs text-ink-500">
          edit live -- changes take effect on the next enrichment run, no redeploy needed
        </p>
      </div>

      {loading ? (
        <p className="font-mono text-xs text-ink-500">loading...</p>
      ) : prompts.length === 0 ? (
        <p className="font-mono text-xs text-ink-500">
          no prompts found -- run <code className="text-accent">bun run db:seed</code> first
        </p>
      ) : (
        <div className="space-y-6">
          {prompts.map((p) => (
            <PromptCard key={p.id} prompt={p} onSaved={onSaved} />
          ))}
        </div>
      )}
    </div>
  );
}
