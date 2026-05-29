'use client';

import { useEffect, useState, useTransition } from 'react';

type Pt = { imageId: number; x: number; y: number; z: number };
type Projection = {
  id: number;
  pointCount: number;
  seed: number;
  createdAt: string;
};

export default function AdminManifoldPage() {
  const [proj, setProj] = useState<Projection | null>(null);
  const [loading, setLoading] = useState(true);
  const [isPending, startTransition] = useTransition();
  const [info, setInfo] = useState<string | null>(null);

  async function load() {
    const res = await fetch('/api/manifold').then((r) => r.json());
    if (res.pointCount != null) {
      setProj({
        // id not returned by the API but we only need display fields here
        id: 0,
        pointCount: res.pointCount as number,
        seed: res.seed as number,
        createdAt: res.createdAt as string
      });
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  function recompute() {
    setInfo(null);
    startTransition(async () => {
      const res = await fetch('/api/admin/manifold/recompute', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setInfo(`enqueued job #${data.jobId} -- wait for cron to drain, then refresh`);
      } else {
        setInfo(`error: ${(data as { error?: string }).error ?? 'failed'}`);
      }
    });
  }

  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="font-display text-3xl text-ink-100">manifold</h1>
        <span className="font-mono text-xs text-ink-500">3D point cloud</span>
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
      ) : proj ? (
        <div className="space-y-2 rounded border border-ink-800 bg-ink-950/60 p-4 font-mono text-xs text-ink-400">
          <div>
            <span className="text-ink-300">points:</span> {proj.pointCount}
          </div>
          <div>
            <span className="text-ink-300">seed:</span> {proj.seed}
          </div>
          <div>
            <span className="text-ink-300">computed:</span>{' '}
            {new Date(proj.createdAt).toLocaleString()}
          </div>
          <p className="mt-3 text-ink-500">
            view the projection at{' '}
            <a href="/manifold" className="text-primary underline">
              /manifold
            </a>
          </p>
        </div>
      ) : (
        <p className="font-mono text-xs text-ink-500">
          no projection yet -- trigger recompute once you have &ge; 4 embedded images
        </p>
      )}
    </div>
  );
}
