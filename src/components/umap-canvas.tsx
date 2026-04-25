'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Point = { imageId: number; x: number; y: number };
type ImageMeta = {
  id: number;
  slug: string;
  // Optional fields wired by the public /map page; absent on /admin/map
  // until we update that page too. Components stay backward compatible.
  blobUrl?: string;
  palette?: string[] | null;
};

type Props = {
  points: Point[];
  images: ImageMeta[]; // maps imageId -> slug (and optional blobUrl + palette)
  height?: number;
};

// Scatter-plot canvas with hover thumbnails and wheel-zoom / drag-pan.
// Points are colored by their dominant palette swatch when available so
// the cluster shape doubles as a faint visual chord. Click navigates to
// the image detail page; hover renders a small thumbnail next to the
// cursor so the cluster shape is browsable without a click.
export function UmapCanvas({ points, images, height = 600 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<Point | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [size, setSize] = useState({ w: 800, h: height });
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(
    null
  );
  // Tracks whether the most recent mouseup ended a drag. Captured before
  // dragRef is cleared so the click handler that fires next can decide
  // whether to suppress navigation.
  const wasDraggingRef = useRef(false);

  // Index by id; rebuilt only when `images` changes so render + hit-test
  // stay O(1) per lookup without thrashing the map on unrelated renders.
  const metaById = useMemo(() => new Map(images.map((i) => [i.id, i])), [images]);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [height]);

  // Compute the static bounding box once per points-set; the zoom/pan
  // applies on top of these base-coordinates so we don't recompute it
  // on every render.
  const bboxRef = useRef({ minX: 0, maxX: 1, minY: 0, maxY: 1 });
  useEffect(() => {
    if (points.length === 0) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const padX = (maxX - minX) * 0.05 || 1;
    const padY = (maxY - minY) * 0.05 || 1;
    bboxRef.current = {
      minX: minX - padX,
      maxX: maxX + padX,
      minY: minY - padY,
      maxY: maxY + padY
    };
  }, [points]);

  const projectPoint = useCallback(
    (p: Point): { x: number; y: number } => {
      const { minX, maxX, minY, maxY } = bboxRef.current;
      const baseX = ((p.x - minX) / (maxX - minX)) * size.w;
      const baseY = ((p.y - minY) / (maxY - minY)) * size.h;
      // Scale + pan: scale around the canvas center, then translate.
      const cx = size.w / 2;
      const cy = size.h / 2;
      return {
        x: (baseX - cx) * scale + cx + translate.x,
        y: (baseY - cy) * scale + cy + translate.y
      };
    },
    [size.w, size.h, scale, translate.x, translate.y]
  );

  useEffect(() => {
    const c = canvasRef.current;
    if (!c || points.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = size.w * dpr;
    c.height = size.h * dpr;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);

    const radius = 3 + Math.min(2, scale - 1);
    for (const p of points) {
      const { x, y } = projectPoint(p);
      if (x < -10 || x > size.w + 10 || y < -10 || y > size.h + 10) continue;
      const meta = metaById.get(p.imageId);
      const palette = meta?.palette;
      const fill =
        palette && palette[0] ? withAlpha(palette[0], 0.75) : 'rgba(99, 179, 237, 0.55)';
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [points, size, projectPoint, scale]);

  function hitTest(clientX: number, clientY: number): Point | null {
    const rect = canvasRef.current!.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    let best: Point | null = null;
    let bestD = 12 * 12;
    for (const p of points) {
      const { x, y } = projectPoint(p);
      const dx = x - mx;
      const dy = y - my;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  function onMove(e: React.MouseEvent) {
    if (dragRef.current) {
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      setTranslate({ x: dragRef.current.baseX + dx, y: dragRef.current.baseY + dy });
      setHover(null);
      return;
    }
    const hit = hitTest(e.clientX, e.clientY);
    setHover(hit);
    if (hit) {
      const rect = canvasRef.current!.getBoundingClientRect();
      setHoverPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    }
  }

  function onClick(e: React.MouseEvent) {
    // Suppress navigation if the mouseup that just preceded this click
    // ended a drag-pan. mouseup clears dragRef before the click fires,
    // so we mirror the "did we drag?" answer into wasDraggingRef during
    // mouseup and consume it here.
    if (wasDraggingRef.current) {
      wasDraggingRef.current = false;
      return;
    }
    const p = hitTest(e.clientX, e.clientY);
    if (!p) return;
    const meta = metaById.get(p.imageId);
    if (meta) window.location.href = `/${meta.slug}`;
  }

  function onMouseDown(e: React.MouseEvent) {
    wasDraggingRef.current = false;
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      baseX: translate.x,
      baseY: translate.y
    };
  }

  function onMouseUp(e: React.MouseEvent) {
    if (
      dragRef.current &&
      (Math.abs(e.clientX - dragRef.current.startX) > 4 ||
        Math.abs(e.clientY - dragRef.current.startY) > 4)
    ) {
      wasDraggingRef.current = true;
    }
    dragRef.current = null;
  }

  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    setScale((prev) => Math.max(0.5, Math.min(8, prev * factor)));
  }

  function reset() {
    setScale(1);
    setTranslate({ x: 0, y: 0 });
  }

  const hoverMeta = hover ? metaById.get(hover.imageId) : null;

  return (
    <div ref={wrapperRef} className="relative w-full select-none">
      <canvas
        ref={canvasRef}
        style={{ width: size.w, height: size.h, cursor: hover ? 'pointer' : 'grab' }}
        className="rounded border border-ink-800 bg-ink-950"
        onMouseMove={onMove}
        onMouseLeave={() => {
          setHover(null);
          dragRef.current = null;
        }}
        onClick={onClick}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onWheel={onWheel}
      />
      {hoverMeta?.blobUrl ? (
        <div
          className="pointer-events-none absolute z-10 overflow-hidden rounded border border-ink-800 bg-ink-950/95 shadow-lg"
          style={{
            left: Math.min(size.w - 132, hoverPos.x + 12),
            top: Math.max(8, hoverPos.y - 132)
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={hoverMeta.blobUrl}
            alt={hoverMeta.slug}
            width={120}
            height={120}
            className="h-30 w-30 object-cover"
            style={{ width: 120, height: 120 }}
          />
          <div className="border-t border-ink-800 px-2 py-1 font-mono text-[10px] text-ink-400">
            {hoverMeta.slug}
          </div>
        </div>
      ) : hoverMeta ? (
        <div className="pointer-events-none absolute left-2 top-2 rounded border border-ink-800 bg-ink-950/90 px-2 py-1 font-mono text-xs text-ink-300">
          {hoverMeta.slug}
        </div>
      ) : null}
      <div className="pointer-events-none absolute right-2 top-2 flex items-center gap-2 font-mono text-[10px] text-ink-500">
        {(scale !== 1 || translate.x !== 0 || translate.y !== 0) && (
          <button
            type="button"
            onClick={reset}
            className="pointer-events-auto rounded border border-ink-800 bg-ink-950/80 px-1.5 py-0.5 hover:text-ink-200"
          >
            reset
          </button>
        )}
        <span>scroll = zoom &middot; drag = pan</span>
      </div>
      {points.length === 0 ? (
        <p className="absolute inset-0 flex items-center justify-center font-mono text-xs text-ink-500">
          no projection yet -- run recompute (owner) once you have &ge; 4 embedded images
        </p>
      ) : null}
    </div>
  );
}

function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return `rgba(99, 179, 237, ${alpha})`;
  const n = Number.parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
