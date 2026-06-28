'use client';

// A compact, ambient minimap of the whole corpus (the UMAP projection) with the
// drift drawn over it as a glowing comet trail: every image is a faint dot, the
// path you've carved is a bright polyline, and where you are right now pulses.
// Read-only -- it exists to make the fall legible ("see where you've drifted
// through meaning"), not to be interacted with. Pure canvas, no deps.

import { useEffect, useMemo, useRef } from 'react';

type Point = { imageId: number; x: number; y: number };

type Props = {
  points: Point[];
  trail: number[]; // visited image ids, in order
  currentId: number | null;
  width?: number;
  height?: number;
};

export function DriftAtlas({ points, trail, currentId, width = 240, height = 160 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const byId = useMemo(() => new Map(points.map((p) => [p.imageId, p])), [points]);
  const bbox = useMemo(() => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const padX = (maxX - minX) * 0.06 || 1;
    const padY = (maxY - minY) * 0.06 || 1;
    return { minX: minX - padX, maxX: maxX + padX, minY: minY - padY, maxY: maxY + padY };
  }, [points]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c || points.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = width * dpr;
    c.height = height * dpr;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const { minX, maxX, minY, maxY } = bbox;
    const proj = (p: Point) => ({
      x: ((p.x - minX) / (maxX - minX || 1)) * width,
      y: ((p.y - minY) / (maxY - minY || 1)) * height
    });

    // Faint corpus.
    ctx.fillStyle = 'rgba(120, 130, 150, 0.20)';
    for (const p of points) {
      const { x, y } = proj(p);
      ctx.beginPath();
      ctx.arc(x, y, 1, 0, Math.PI * 2);
      ctx.fill();
    }

    // The trail: a glowing polyline through visited points that exist in the
    // projection (a freshly-uploaded image may not be projected yet -- skip it).
    const pts = trail.map((id) => byId.get(id)).filter((p): p is Point => !!p).map(proj);
    if (pts.length >= 2) {
      ctx.strokeStyle = 'rgba(99, 179, 237, 0.85)';
      ctx.lineWidth = 1.4;
      ctx.shadowColor = 'rgba(99, 179, 237, 0.9)';
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.moveTo(pts[0]!.x, pts[0]!.y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Where you are now.
    const cur = currentId !== null ? byId.get(currentId) : undefined;
    if (cur) {
      const { x, y } = proj(cur);
      ctx.fillStyle = 'rgba(99, 179, 237, 1)';
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(99, 179, 237, 0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, [points, trail, currentId, byId, bbox, width, height]);

  if (points.length === 0) return null;

  return (
    <canvas
      ref={canvasRef}
      style={{ width, height }}
      className="rounded-md border border-ink-800/80 bg-ink-950/70"
      aria-hidden="true"
    />
  );
}
