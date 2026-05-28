'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ImageCard } from './image-card';
import type { ImageWithRelations } from '@/lib/db/queries/images';

// Mirrors the LS_* pattern in src/components/sort-bar.tsx. Keep the key
// name in sync if either side changes -- a stray rename here silently
// breaks the live toggle.
const LS_AUTOLOAD = 'pix_autoload';
type AutoloadMode = 'on' | 'off';

type QueryValue = string | string[] | undefined;

type Props = {
  initial: ImageWithRelations[];
  // Endpoint must return `{ images: ImageWithRelations[] }` and honor
  // `limit` + `offset` query params. The three endpoints we ship today
  // (/api/images, /api/u/[handle]/images, /api/color/[hex]/images) all
  // hydrate via the same `hydrateImages` helper so the shape lines up.
  endpoint: string;
  query?: Record<string, QueryValue>;
  pageSize?: number;
  similarities?: Map<number, number>;
};

function readAutoload(): AutoloadMode {
  if (typeof window === 'undefined') return 'on';
  try {
    return window.localStorage.getItem(LS_AUTOLOAD) === 'off' ? 'off' : 'on';
  } catch {
    return 'on';
  }
}

function buildQueryString(query: Record<string, QueryValue> | undefined, limit: number, offset: number): string {
  const params = new URLSearchParams();
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === '') continue;
      if (Array.isArray(value)) {
        for (const v of value) {
          if (v) params.append(key, v);
        }
      } else {
        params.append(key, value);
      }
    }
  }
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  return params.toString();
}

export function InfiniteImageGrid({
  initial,
  endpoint,
  query,
  pageSize = 16,
  similarities
}: Props) {
  const [items, setItems] = useState<ImageWithRelations[]>(initial);
  // `hasMore` flips false once a response returns < pageSize rows. The
  // first page is the SSR'd initial set; if SSR already returned fewer
  // than pageSize rows there's nothing more to fetch.
  const [hasMore, setHasMore] = useState<boolean>(initial.length >= pageSize);
  const [isLoading, setIsLoading] = useState(false);
  const [autoload, setAutoload] = useState<AutoloadMode>('on');
  // Guards against concurrent fetches (rapid scroll + manual click).
  const inFlight = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const seenIds = useRef<Set<number>>(new Set(initial.map((i) => i.id)));
  // Generation counter -- incremented whenever the parent gives us a new
  // `initial`/`endpoint`/`query` (i.e. visitor changed sort/seed/tag).
  // A loadMore() captures the current generation in its closure; when it
  // resolves, if the counter has moved on, we drop the response. Also
  // aborts the underlying fetch so the server can short-circuit.
  const generation = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  // Re-seed local state when the parent passes a different initial set,
  // endpoint, or query (e.g. visitor changed sort and the server
  // re-rendered the page). Bumping `generation` and aborting any in-flight
  // request prevents a late response from the previous sort from being
  // appended onto the new initial set.
  useEffect(() => {
    generation.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    inFlight.current = false;
    setItems(initial);
    setHasMore(initial.length >= pageSize);
    setIsLoading(false);
    seenIds.current = new Set(initial.map((i) => i.id));
  }, [initial, endpoint, query, pageSize]);

  // Subscribe to the autoload toggle. `storage` events normally only
  // fire cross-tab, but SortBar dispatches a synthetic one after writing
  // so a same-tab toggle still updates this component live.
  useEffect(() => {
    setAutoload(readAutoload());
    function onStorage(e: StorageEvent) {
      if (e.key !== LS_AUTOLOAD && e.key !== null) return;
      setAutoload(readAutoload());
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const loadMore = useCallback(async () => {
    if (inFlight.current || !hasMore) return;
    inFlight.current = true;
    setIsLoading(true);
    const myGen = generation.current;
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const qs = buildQueryString(query, pageSize, items.length);
      const res = await fetch(`${endpoint}?${qs}`, {
        cache: 'no-store',
        signal: controller.signal
      });
      // If the parent re-rendered with new initial/sort while we were
      // waiting, the response belongs to a stale query -- drop it.
      if (myGen !== generation.current) return;
      if (!res.ok) {
        // Soft failure: don't permanently halt the loop; the next sentinel
        // intersection (or button click) can retry.
        return;
      }
      const data = (await res.json()) as { images?: ImageWithRelations[] };
      if (myGen !== generation.current) return;
      const incoming = Array.isArray(data.images) ? data.images : [];
      // Dedup against rows already on the page. Guards against the
      // candidate-window / base-tail seam in fetchInSortOrder and against
      // new rows inserted mid-scroll shifting offsets.
      const fresh: ImageWithRelations[] = [];
      for (const img of incoming) {
        if (seenIds.current.has(img.id)) continue;
        seenIds.current.add(img.id);
        fresh.push(img);
      }
      if (fresh.length > 0) {
        setItems((prev) => prev.concat(fresh));
      }
      if (incoming.length < pageSize) {
        setHasMore(false);
      }
    } catch {
      // Network hiccup or AbortError -- leave hasMore true so retries can
      // resume. Aborted fetches are an expected control flow when the
      // visitor changes sort mid-load, not an error to surface.
    } finally {
      if (myGen === generation.current) {
        setIsLoading(false);
      }
      inFlight.current = false;
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [endpoint, hasMore, items.length, pageSize, query]);

  // IntersectionObserver auto-loader. Only attaches when autoload is on
  // and there's more to fetch -- the "manual" mode renders a button
  // instead of the sentinel.
  useEffect(() => {
    if (autoload !== 'on') return;
    if (!hasMore) return;
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            void loadMore();
          }
        }
      },
      // rootMargin pre-loads a viewport ahead so the user rarely sees
      // the spinner. 600px is roughly one mobile screen height.
      { rootMargin: '600px 0px 600px 0px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [autoload, hasMore, loadMore]);

  if (items.length === 0) {
    return (
      <p className="py-24 text-center font-mono text-sm text-ink-500">
        no pictures here yet
      </p>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-10">
      {items.map((img) => (
        <ImageCard
          key={img.id}
          image={img}
          similarity={similarities?.get(img.id)}
        />
      ))}
      {hasMore ? (
        autoload === 'on' ? (
          <div ref={sentinelRef} className="py-8 text-center font-mono text-xs text-ink-500">
            {isLoading ? 'loading more...' : null}
          </div>
        ) : (
          <div className="py-6 text-center">
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={isLoading}
              className="rounded border border-ink-800 bg-ink-950/60 px-4 py-2 font-mono text-xs uppercase tracking-wider text-ink-100 hover:border-primary/40 disabled:opacity-50"
            >
              {isLoading ? 'loading...' : 'load more'}
            </button>
          </div>
        )
      ) : null}
    </div>
  );
}
