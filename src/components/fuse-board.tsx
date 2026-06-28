'use client';

// /fuse -- image alchemy. Tap two specimens to fuse them: the server returns the
// real image nearest the centroid of their caption embeddings -- the thing that
// lives "between" them. New results join your board, and you fuse discoveries
// into deeper ones. Deterministic (same pair = same fusion), so a board is a
// shareable collection. Pure React, no new deps; the fusion math is server-side.

import { useCallback, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { PathNode } from '@/lib/knn-path-types';
import { compositePrompt, COMPOSITE_PROMPT_MODEL } from '@/lib/fuse/composite-prompt';

type Props = {
  initial: PathNode[]; // starting inventory (random seeds, or a shared board)
  // When true (owner/admin only) the reveal offers a live gpt-image-2 render.
  isAdmin?: boolean;
};

const BOARD_CAP = 60; // matches the page's MAX_BOARD (share/restore cap)

function detailUrl(node: PathNode): string {
  return node.handle ? `/u/${node.handle}/${node.slug}` : `/${node.slug}`;
}

type Reveal = {
  a: PathNode;
  b: PathNode;
  result: PathNode | null;
  isNew: boolean;
  pending: boolean;
  // Set on a real fuse error (429/422/500/network) so the UI can distinguish it
  // from a legitimate "no distinct result".
  error?: string;
};

export function FuseBoard({ initial, isAdmin = false }: Props) {
  const router = useRouter();
  const [inventory, setInventory] = useState<PathNode[]>(initial);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFallback, setCopyFallback] = useState('');
  const [promptCopied, setPromptCopied] = useState(false);
  // Live gpt-image-2 render (admin only). Reset on every new fusion.
  const [rendering, setRendering] = useState(false);
  const [renderUrl, setRenderUrl] = useState('');
  const [renderError, setRenderError] = useState('');

  const busyRef = useRef(false);
  const renderingRef = useRef(false);
  // Bumped on every new pairing so a slow render from the previous pair can be
  // ignored when it resolves (it would otherwise show under the new pairing).
  const renderGenRef = useRef(0);
  const inventoryRef = useRef(inventory);
  inventoryRef.current = inventory;

  // The original seeds are the "primordial" elements; everything else is a find.
  const seedIds = useMemo(() => new Set(initial.map((n) => n.imageId)), [initial]);
  const byId = useMemo(() => new Map(inventory.map((n) => [n.imageId, n])), [inventory]);
  const discovered = useMemo(
    () => inventory.filter((n) => !seedIds.has(n.imageId)).length,
    [inventory, seedIds]
  );

  const doFuse = useCallback(
    async (aId: number, bId: number) => {
      if (busyRef.current) return;
      const a = byId.get(aId);
      const b = byId.get(bId);
      if (!a || !b) return;
      busyRef.current = true;
      setRenderUrl(''); // a new pairing -- drop any prior render
      setRenderError('');
      renderGenRef.current += 1; // supersede any in-flight render from the old pair
      setReveal({ a, b, result: null, isNew: false, pending: true });
      try {
        const res = await fetch('/api/fuse', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ a: aId, b: bId })
        });
        if (res.ok) {
          const data = (await res.json()) as { node?: PathNode | null };
          const node = data.node ?? null;
          const isNew = !!node && !inventoryRef.current.some((n) => n.imageId === node.imageId);
          if (node && isNew) setInventory((inv) => [...inv, node]);
          setReveal({ a, b, result: node, isNew, pending: false });
        } else {
          // A real error (429 rate limit / 422 unfusable / 500) is NOT the same as
          // a legitimate "no distinct result" -- surface it distinctly.
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          setReveal({ a, b, result: null, isNew: false, pending: false, error: data.error || `fuse failed (${res.status})` });
        }
      } catch {
        setReveal({ a, b, result: null, isNew: false, pending: false, error: 'fuse failed -- network error' });
      } finally {
        busyRef.current = false;
      }
    },
    [byId]
  );

  const onTile = useCallback(
    (id: number) => {
      if (busyRef.current) return;
      if (selectedId === null) {
        setSelectedId(id);
      } else if (selectedId === id) {
        setSelectedId(null); // tap again to deselect
      } else {
        const a = selectedId;
        setSelectedId(null);
        void doFuse(a, id);
      }
    },
    [selectedId, doFuse]
  );

  const share = useCallback(async () => {
    const ids = inventoryRef.current.map((n) => n.imageId).slice(-BOARD_CAP);
    const url = `${window.location.origin}/fuse?have=${ids.join(',')}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setCopyFallback('');
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopyFallback(url);
    }
  }, []);

  // "new board" must re-seed even when already on bare /fuse (same href would be
  // a no-op), so refresh re-runs the random-seeding server page.
  const newBoard = useCallback(() => {
    if (typeof window !== 'undefined' && window.location.search) router.push('/fuse');
    else router.refresh();
  }, [router]);

  // Copy the composite generation prompt for the current pairing. The readonly
  // textarea it lives in is selectable, so it doubles as the manual fallback.
  const copyPrompt = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setPromptCopied(true);
      window.setTimeout(() => setPromptCopied(false), 1800);
    } catch {
      /* clipboard blocked -- the visible textarea is the fallback */
    }
  }, []);

  // Admin only: render the imagined blend for real via gpt-image-2. The server
  // route is the authoritative gate; the client guard just bounds double-clicks.
  const renderForReal = useCallback(async (aId: number, bId: number) => {
    if (renderingRef.current) return;
    renderingRef.current = true;
    setRendering(true);
    setRenderError('');
    setRenderUrl('');
    const myGen = renderGenRef.current;
    const superseded = () => myGen !== renderGenRef.current; // a new pairing happened
    const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
    try {
      // Enqueue the background render; the route returns a job id immediately.
      const res = await fetch('/api/fuse/render', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ a: aId, b: bId })
      });
      const data = (await res.json().catch(() => ({}))) as { jobId?: number; error?: string };
      if (superseded()) return;
      if (!res.ok || !data.jobId) {
        setRenderError(data.error || `render failed (${res.status})`);
        return;
      }
      // Poll the job until it finishes. The render runs in the cron drain, so the
      // first paint can take a minute or two.
      const deadline = Date.now() + 240_000; // give up polling after ~4 min
      while (Date.now() < deadline) {
        await sleep(3000);
        if (superseded()) return;
        const pres = await fetch(`/api/fuse/render?job=${data.jobId}`);
        const pdata = (await pres.json().catch(() => ({}))) as {
          status?: string;
          url?: string | null;
          error?: string | null;
        };
        if (superseded()) return;
        if (pdata.status === 'done' && pdata.url) {
          setRenderUrl(pdata.url);
          return;
        }
        if (pdata.status === 'failed') {
          setRenderError(pdata.error || 'render failed');
          return;
        }
        // pending / processing -> keep polling
      }
      setRenderError('still rendering -- check /admin/jobs for the result');
    } catch {
      if (!superseded()) setRenderError('render failed -- network error');
    } finally {
      renderingRef.current = false;
      setRendering(false);
    }
  }, []);

  // The image-2 prompt for the imagined blend of the two parents (not the nearest
  // existing result), shown once a fusion settles.
  const promptText = reveal && !reveal.pending ? compositePrompt(reveal.a.caption, reveal.b.caption) : '';

  return (
    <div className="space-y-6 pt-8">
      <section className="space-y-1">
        <h1 className="font-fungal-lite text-3xl text-ink-100">fuse</h1>
        <p className="font-mono text-xs leading-relaxed text-ink-500">
          image alchemy -- tap two specimens to fuse them and discover the one that lives between them.
          fuse your finds into deeper ones; every recipe is stable, so a board is yours to share.
        </p>
      </section>

      {/* Reveal: A + B = C (or "fusing..."). Sits above the board so each fusion
          announces itself without scrolling. */}
      {reveal ? (
        <section className="rounded-xl border border-primary/30 bg-primary/5 p-4">
          <div className="flex items-center justify-center gap-3 sm:gap-4">
            <Thumb node={reveal.a} size="sm" />
            <span className="font-mono text-lg text-ink-500">+</span>
            <Thumb node={reveal.b} size="sm" />
            <span className="font-mono text-lg text-primary">=</span>
            {reveal.pending ? (
              <div className="flex aspect-square w-20 items-center justify-center rounded-md border border-dashed border-primary/40 bg-ink-950 font-mono text-xs text-primary sm:w-24">
                fusing&hellip;
              </div>
            ) : reveal.result ? (
              <Thumb node={reveal.result} size="lg" glow />
            ) : reveal.error ? (
              <div className="flex aspect-square w-20 items-center justify-center rounded-md border border-dashed border-rose-500/50 bg-ink-950 p-1 text-center font-mono text-[10px] leading-tight text-rose-300 sm:w-24">
                {reveal.error}
              </div>
            ) : (
              <div className="flex aspect-square w-20 items-center justify-center rounded-md border border-dashed border-ink-700 bg-ink-950 text-center font-mono text-[10px] text-ink-500 sm:w-24">
                nothing new between them
              </div>
            )}
          </div>
          {reveal.result && !reveal.pending ? (
            <div className="mt-3 text-center">
              <span
                className={
                  'font-mono text-[10px] uppercase tracking-wider ' +
                  (reveal.isNew ? 'text-primary' : 'text-ink-500')
                }
              >
                {reveal.isNew ? 'new discovery' : 'already in your board'}
              </span>
              <Link
                href={detailUrl(reveal.result)}
                className="mt-0.5 block font-fungal-lite text-lg leading-snug text-ink-100 hover:text-primary"
              >
                {reveal.result.caption || reveal.result.slug}
              </Link>
            </div>
          ) : null}

          {/* The nearest existing specimen is above; this is a prompt to generate
              the IMAGINED blend (targeting OpenAI's image-2 model). */}
          {!reveal.pending ? (
            <details className="mt-3 rounded-lg border border-ink-800/70 bg-ink-950/50 p-3 text-left">
              <summary className="cursor-pointer font-mono text-[11px] text-ink-400 hover:text-primary">
                generate this fusion &middot; {COMPOSITE_PROMPT_MODEL} prompt
              </summary>
              <p className="mt-2 font-mono text-[10px] leading-relaxed text-ink-500">
                paste into ChatGPT or the OpenAI Image API ({COMPOSITE_PROMPT_MODEL}) to render the
                imagined blend that doesn&rsquo;t exist yet.
              </p>
              <textarea
                readOnly
                rows={5}
                value={promptText}
                onFocus={(e) => e.currentTarget.select()}
                className="mt-2 w-full resize-none rounded border border-ink-700 bg-ink-950 p-2 font-mono text-[10px] leading-relaxed text-ink-300"
              />
              <button
                type="button"
                onClick={() => copyPrompt(promptText)}
                className="mt-2 rounded border border-primary/50 bg-primary/10 px-3 py-1 font-mono text-[11px] text-primary hover:bg-primary/20"
              >
                {promptCopied ? 'prompt copied!' : 'copy prompt'}
              </button>

              {/* Owner/admin only: spend on a live gpt-image-2 render of the
                  imagined blend. The /api/fuse/render route enforces the gate. */}
              {isAdmin ? (
                <div className="mt-3 space-y-2 border-t border-ink-800/60 pt-3">
                  <button
                    type="button"
                    disabled={rendering}
                    onClick={() => reveal && renderForReal(reveal.a.imageId, reveal.b.imageId)}
                    className="rounded border border-primary/60 bg-primary/15 px-3 py-1 font-mono text-[11px] text-primary hover:bg-primary/25 disabled:opacity-60"
                  >
                    {rendering ? 'rendering with gpt-image-2...' : 'render for real (gpt-image-2)'}
                  </button>
                  {rendering && !renderUrl && !renderError ? (
                    <p className="font-mono text-[10px] text-ink-500">
                      queued -- generation runs in the background; this can take a minute or two.
                    </p>
                  ) : null}
                  {renderError ? <p className="font-mono text-[10px] text-rose-300">{renderError}</p> : null}
                  {renderUrl ? (
                    <a
                      href={renderUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="block overflow-hidden rounded-md border border-primary/40"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={renderUrl} alt="rendered fusion" className="w-full" />
                    </a>
                  ) : null}
                </div>
              ) : null}
            </details>
          ) : null}
        </section>
      ) : null}

      {/* The board */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="font-mono text-[10px] uppercase tracking-wider text-ink-500">
            your specimens &middot; {inventory.length}
            {discovered > 0 ? <span className="text-primary"> ({discovered} found)</span> : null}
          </p>
          <p className="font-mono text-[10px] text-ink-600">
            {selectedId !== null ? 'pick a second to fuse' : 'tap two to fuse'}
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
          {inventory.map((node) => {
            const isSelected = selectedId === node.imageId;
            const isFind = !seedIds.has(node.imageId);
            return (
              <button
                key={node.imageId}
                type="button"
                onClick={() => onTile(node.imageId)}
                title={node.caption || node.slug}
                aria-pressed={isSelected}
                className={
                  'group relative aspect-square overflow-hidden rounded-md border bg-ink-950 transition-all ' +
                  (isSelected
                    ? 'border-primary ring-2 ring-primary/60'
                    : 'border-ink-800/80 hover:border-primary/60')
                }
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={node.blobUrl}
                  alt={node.caption || node.slug}
                  className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.05]"
                />
                {isFind ? (
                  <span className="absolute right-1 top-1 rounded-full bg-primary/80 px-1 font-mono text-[8px] uppercase leading-tight text-ink-950">
                    found
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </section>

      {/* Actions */}
      <section className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={share}
          className="rounded border border-primary/50 bg-primary/10 px-4 py-1.5 font-mono text-xs text-primary hover:bg-primary/20"
        >
          {copied ? 'board link copied!' : 'share your board'}
        </button>
        <button
          type="button"
          onClick={newBoard}
          className="rounded border border-ink-700 bg-ink-900 px-4 py-1.5 font-mono text-xs text-ink-200 hover:border-primary/50 hover:text-primary"
        >
          new board
        </button>
        <span className="font-mono text-[11px] text-ink-600">
          a shared board hands a friend your specimens to keep fusing.
        </span>
      </section>

      {copyFallback ? (
        <div className="space-y-1">
          <p className="font-mono text-[10px] text-ink-500">copy didn&rsquo;t work -- select and copy this:</p>
          <textarea
            readOnly
            value={copyFallback}
            rows={2}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full resize-none rounded border border-ink-700 bg-ink-950 p-2 font-mono text-[11px] text-ink-300"
          />
        </div>
      ) : null}
    </div>
  );
}

function Thumb({ node, size, glow }: { node: PathNode; size: 'sm' | 'lg'; glow?: boolean }) {
  const dim = size === 'lg' ? 'w-20 sm:w-24' : 'w-14 sm:w-16';
  return (
    <Link
      href={detailUrl(node)}
      title={node.caption || node.slug}
      className={
        'block aspect-square shrink-0 overflow-hidden rounded-md border bg-ink-950 ' +
        dim +
        (glow ? ' border-primary shadow-[0_0_18px_-2px] shadow-primary/50' : ' border-ink-800/80')
      }
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={node.blobUrl} alt={node.caption || node.slug} className="h-full w-full object-cover" />
    </Link>
  );
}
