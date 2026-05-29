'use client';

import { useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';

export type FittestRow = {
  imageId: number;
  slug: string;
  handle: string | null;
  blobUrl: string;
  generation: number;
  fitness: number;
  hasEmbedding: boolean;
  archived: boolean;
};

export type PopulationStats = {
  total: number;
  archived: number;
  active: number;
  maxGeneration: number;
};

type ReproduceResult = {
  dryRun: boolean;
  child: {
    id?: number;
    slug?: string;
    blobUrl?: string;
    generation: number;
    prompt: string;
    tags: string[];
    dirichletWeights: [number, number];
    embeddingDims?: number;
    provider?: string;
    model?: string;
  };
  archived?: { id: number; slug: string };
  wouldArchive?: { id: number; slug: string };
  cap?: { populationCap: number; activeBefore: number };
};

export function AliveClient({
  rows,
  stats
}: {
  rows: FittestRow[];
  stats: PopulationStats;
}) {
  const [parentA, setParentA] = useState('');
  const [parentB, setParentB] = useState('');
  const [cap, setCap] = useState('');
  const [alpha, setAlpha] = useState('1.0');
  const [dryRun, setDryRun] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ReproduceResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Local archive overlay so a toggle reflects immediately without a reload.
  const [archivedOverride, setArchivedOverride] = useState<Record<number, boolean>>({});

  async function submitReproduce() {
    setError(null);
    setResult(null);
    const a = Number(parentA);
    const b = Number(parentB);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0) {
      setError('Parent A and Parent B must be positive image ids.');
      return;
    }
    if (a === b) {
      setError('Parents must be two distinct images.');
      return;
    }
    // Confirm before a REAL birth (dry-run needs no confirmation).
    if (!dryRun) {
      const ok = window.confirm(
        `Create a real child from ${a} x ${b}?` +
          (cap ? ` Population cap ${cap} may archive the least-fit image.` : '')
      );
      if (!ok) return;
    }

    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        parentAId: a,
        parentBId: b,
        dryRun
      };
      if (cap) body.populationCap = Number(cap);
      if (alpha) body.alpha = Number(alpha);
      const res = await fetch('/api/admin/alive/reproduce', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? 'reproduce failed');
        return;
      }
      setResult(json as ReproduceResult);
    } catch {
      setError('network error');
    } finally {
      setBusy(false);
    }
  }

  async function toggleArchive(row: FittestRow) {
    const currentlyArchived = archivedOverride[row.imageId] ?? row.archived;
    const action = currentlyArchived ? 'unarchive' : 'archive';
    if (action === 'archive') {
      const ok = window.confirm(
        `Archive "${row.slug}"? It vanishes from public surfaces but is recoverable (never deleted).`
      );
      if (!ok) return;
    }
    try {
      const res = await fetch('/api/admin/alive/archive', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ imageId: row.imageId, action })
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.error ?? 'archive toggle failed');
        return;
      }
      setArchivedOverride((prev) => ({ ...prev, [row.imageId]: action === 'archive' }));
    } catch {
      setError('network error');
    }
  }

  return (
    <div className="space-y-8">
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="total" value={stats.total} />
        <Stat label="active" value={stats.active} />
        <Stat label="archived" value={stats.archived} />
        <Stat label="max generation" value={stats.maxGeneration} />
      </section>

      <section className="space-y-3 rounded border border-ink-800 p-4">
        <h2 className="font-mono text-sm text-ink-200">reproduce</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="parent A id">
            <input
              value={parentA}
              onChange={(e) => setParentA(e.target.value)}
              inputMode="numeric"
              className="w-full rounded border border-ink-700 bg-ink-950 px-2 py-1 font-mono text-sm text-ink-100"
              placeholder="e.g. 12"
            />
          </Field>
          <Field label="parent B id">
            <input
              value={parentB}
              onChange={(e) => setParentB(e.target.value)}
              inputMode="numeric"
              className="w-full rounded border border-ink-700 bg-ink-950 px-2 py-1 font-mono text-sm text-ink-100"
              placeholder="e.g. 34"
            />
          </Field>
          <Field label="population cap (optional)">
            <input
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              inputMode="numeric"
              className="w-full rounded border border-ink-700 bg-ink-950 px-2 py-1 font-mono text-sm text-ink-100"
              placeholder="leave blank for no cap"
            />
          </Field>
          <Field label="dirichlet alpha">
            <input
              value={alpha}
              onChange={(e) => setAlpha(e.target.value)}
              inputMode="decimal"
              className="w-full rounded border border-ink-700 bg-ink-950 px-2 py-1 font-mono text-sm text-ink-100"
              placeholder="1.0"
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 font-mono text-xs text-ink-300">
          <input
            type="checkbox"
            checked={dryRun}
            onChange={(e) => setDryRun(e.target.checked)}
          />
          dry-run (compute and preview only -- writes nothing)
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={submitReproduce}
          className="rounded bg-ink-100 px-3 py-1.5 font-mono text-xs text-ink-950 disabled:opacity-50"
        >
          {busy ? 'working...' : dryRun ? 'preview (dry-run)' : 'reproduce (real)'}
        </button>

        {error && <p className="font-mono text-xs text-red-400">{error}</p>}

        {result && (
          <div className="space-y-1 rounded border border-ink-800 bg-ink-950 p-3 font-mono text-xs text-ink-300">
            <p className="text-ink-100">
              {result.dryRun ? 'DRY-RUN -- nothing was written' : 'child created'}
            </p>
            {result.child.id != null && (
              <p>
                child id {result.child.id}{' '}
                <Link className="underline" href={`/lineage?root=${result.child.slug}`}>
                  family tree
                </Link>
              </p>
            )}
            <p>generation: {result.child.generation}</p>
            <p>prompt: {result.child.prompt}</p>
            <p>inherited tags: {result.child.tags.join(', ') || '(none)'}</p>
            <p>
              dirichlet weights: [{result.child.dirichletWeights[0].toFixed(3)},{' '}
              {result.child.dirichletWeights[1].toFixed(3)}]
            </p>
            {result.wouldArchive && (
              <p className="text-amber-400">
                would archive: id {result.wouldArchive.id} ({result.wouldArchive.slug})
              </p>
            )}
            {result.archived && (
              <p className="text-amber-400">
                archived to honor cap: id {result.archived.id} ({result.archived.slug})
              </p>
            )}
            {result.cap && (
              <p>
                cap {result.cap.populationCap}, active before birth {result.cap.activeBefore}
              </p>
            )}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="font-mono text-sm text-ink-200">top 10 fittest (by decayed attention)</h2>
        <ul className="space-y-2">
          {rows.map((row) => {
            const archived = archivedOverride[row.imageId] ?? row.archived;
            return (
              <li
                key={row.imageId}
                className="flex items-center gap-3 rounded border border-ink-800 p-2"
              >
                <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded bg-ink-900">
                  <Image
                    src={row.blobUrl}
                    alt={row.slug}
                    fill
                    sizes="48px"
                    className={`object-cover ${archived ? 'opacity-40' : ''}`}
                  />
                </div>
                <div className="min-w-0 flex-1 font-mono text-xs text-ink-300">
                  <p className="truncate text-ink-100">
                    #{row.imageId} {row.slug}
                    {archived && <span className="ml-2 text-amber-400">[archived]</span>}
                  </p>
                  <p>
                    fitness {row.fitness.toFixed(3)} -- gen {row.generation}
                    {!row.hasEmbedding && (
                      <span className="ml-2 text-ink-600">no embedding (cannot breed)</span>
                    )}
                  </p>
                </div>
                <Link
                  className="font-mono text-xs text-ink-400 underline hover:text-ink-100"
                  href={`/lineage?root=${row.slug}`}
                >
                  tree
                </Link>
                <button
                  type="button"
                  onClick={() => toggleArchive(row)}
                  className="rounded border border-ink-700 px-2 py-1 font-mono text-xs text-ink-300 hover:text-ink-100"
                >
                  {archived ? 'unarchive' : 'archive'}
                </button>
              </li>
            );
          })}
          {rows.length === 0 && (
            <li className="font-mono text-xs text-ink-500">no images yet.</li>
          )}
        </ul>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-ink-800 p-3">
      <p className="font-mono text-2xl text-ink-100">{value}</p>
      <p className="font-mono text-xs text-ink-500">{label}</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="font-mono text-xs text-ink-500">{label}</span>
      {children}
    </label>
  );
}
