'use client';

import { useEffect, useState, useTransition } from 'react';
import { UmapCanvas } from '@/components/umap-canvas';

type Pt = { imageId: number; x: number; y: number };
type Projection = { id: number; pointCount: number; points: Pt[]; params: unknown; createdAt: string };

export default function AdminMapPage() {
  const [proj, setProj] = useState<Projection | null>(null);
  const [metas, setMetas] = useState<{ id: number; slug: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [isPending, startTransition] = useTransition();
  const [info, setInfo] = useState<string | null>(null);

  async function load() {
    const res = await fetch('/api/admin/umap').then((r) => r.json());
    setProj(res.projection ?? null);
    setMetas(res.metas ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  function recompute() {
    setInfo(null);
    startTransition(async () => {
      const res = await fetch('/api/admin/umap/recompute', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setInfo(`enqueued job #${data.jobId} -- wait for cron to drain, then refresh`);
      } else {
        setInfo(`error: ${data.error ?? 'failed'}`);
      }
    });
  }

  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="font-display text-3xl text-ink-100">map</h1>
        <button
          type="button"
          onClick={recompute}
          disabled={isPending}
          className="ml-auto rounded border border-primary/50 bg-primary/10 px-3 py-1.5 font-mono text-xs text-primary hover:bg-primary/20 disabled:opacity-50"
        >
          {isPending ? 'enqueuing...' : 'recompute'}
        </button>
      </div>
      {info ? <p className="font-mono text-xs text-ink-300">{info}</p> : null}
      {loading ? (
        <p className="font-mono text-xs text-ink-500">loading...</p>
      ) : (
        <UmapCanvas points={proj?.points ?? []} images={metas} height={640} />
      )}
      {proj ? (
        <p className="font-mono text-xs text-ink-500">
          {proj.pointCount} points -- last computed {new Date(proj.createdAt).toLocaleString()}
        </p>
      ) : null}
    </div>
  );
}
