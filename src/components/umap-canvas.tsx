'use client';

import { useEffect, useRef, useState } from 'react';

type Point = { imageId: number; x: number; y: number };
type ImageMeta = { id: number; slug: string };

type Props = {
  points: Point[];
  images: ImageMeta[]; // maps imageId -> slug so clicks can navigate
  height?: number;
};

// Minimal scatter-plot canvas. No d3; just scale to viewport and dot per point.
// Hover reveals the slug; click navigates. Good enough for Phase 4; a future
// iteration can swap in thumbnails sampled from visible viewport.
export function UmapCanvas({ points, images, height = 600 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<Point | null>(null);
  const [size, setSize] = useState({ w: 800, h: height });

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [height]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c || points.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = size.w * dpr;
    c.height = size.h * dpr;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, size.w, size.h);

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
    minX -= padX;
    maxX += padX;
    minY -= padY;
    maxY += padY;

    ctx.fillStyle = 'rgba(99, 179, 237, 0.55)';
    for (const p of points) {
      const x = ((p.x - minX) / (maxX - minX)) * size.w;
      const y = ((p.y - minY) / (maxY - minY)) * size.h;
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    function hitTest(clientX: number, clientY: number): Point | null {
      const rect = c!.getBoundingClientRect();
      const mx = clientX - rect.left;
      const my = clientY - rect.top;
      let best: Point | null = null;
      let bestD = 10 * 10;
      for (const p of points) {
        const x = ((p.x - minX) / (maxX - minX)) * size.w;
        const y = ((p.y - minY) / (maxY - minY)) * size.h;
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

    function onMove(e: MouseEvent) {
      setHover(hitTest(e.clientX, e.clientY));
    }
    function onClick(e: MouseEvent) {
      const p = hitTest(e.clientX, e.clientY);
      if (!p) return;
      const meta = images.find((i) => i.id === p.imageId);
      if (meta) window.location.href = `/${meta.slug}`;
    }
    c.addEventListener('mousemove', onMove);
    c.addEventListener('click', onClick);
    return () => {
      c.removeEventListener('mousemove', onMove);
      c.removeEventListener('click', onClick);
    };
  }, [points, images, size]);

  const hoverMeta = hover ? images.find((i) => i.id === hover.imageId) : null;

  return (
    <div ref={wrapperRef} className="relative w-full">
      <canvas
        ref={canvasRef}
        style={{ width: size.w, height: size.h }}
        className="rounded border border-ink-800 bg-ink-950"
      />
      {hoverMeta ? (
        <div className="pointer-events-none absolute left-2 top-2 rounded border border-ink-800 bg-ink-950/90 px-2 py-1 font-mono text-xs text-ink-300">
          {hoverMeta.slug}
        </div>
      ) : null}
      {points.length === 0 ? (
        <p className="absolute inset-0 flex items-center justify-center font-mono text-xs text-ink-500">
          no projection yet -- run recompute (owner) once you have &ge; 4 embedded images
        </p>
      ) : null}
    </div>
  );
}
