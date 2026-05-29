'use client';

// Three.js / r3f scene for the 3D manifold point cloud.
// Guarded behind next/dynamic ssr:false in the page so this module only
// loads client-side -- Three.js has no SSR-safe path in Next 14 App Router.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Points, PointMaterial } from '@react-three/drei';
import * as THREE from 'three';
import { useRouter } from 'next/navigation';

export type ManifoldPoint = { imageId: number; x: number; y: number; z: number };
export type ManifoldImage = {
  id: number;
  slug: string;
  handle: string;
  blobUrl: string;
  palette: string[] | null;
};

type Props = {
  points: ManifoldPoint[];
  images: ManifoldImage[];
};

// How many points around the camera we eagerly fetch thumbnails for.
// Thumbnails outside this radius use only the palette colour dot; hovering
// one still shows the slug label. This avoids loading every blob URL at once.
const THUMB_LOAD_RADIUS = 2.5;

// Hex colour string -> [r, g, b] in 0..1. Returns a muted blue-grey fallback
// for rows with no palette so points are always visible.
function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return [0.38, 0.70, 0.93];
  const n = Number.parseInt(m[1]!, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff].map((c) => c / 255) as [
    number,
    number,
    number
  ];
}

// Normalise a set of 3D points to fit inside [-1, 1]^3 so the initial camera
// distance is predictable regardless of what UMAP spat out.
function normalisePoints(raw: ManifoldPoint[]): ManifoldPoint[] {
  if (raw.length === 0) return raw;
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (const p of raw) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
  }
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;
  const rangeZ = maxZ - minZ || 1;
  const range = Math.max(rangeX, rangeY, rangeZ);
  return raw.map((p) => ({
    imageId: p.imageId,
    x: ((p.x - (minX + maxX) / 2) / range) * 2,
    y: ((p.y - (minY + maxY) / 2) / range) * 2,
    z: ((p.z - (minZ + maxZ) / 2) / range) * 2
  }));
}

// ----- inner scene (runs inside <Canvas>) -----

type SceneProps = Props & {
  onHover: (point: ManifoldPoint | null) => void;
  onClickPoint: (point: ManifoldPoint) => void;
};

function ManifoldPoints({ points, images, onHover, onClickPoint }: SceneProps) {
  const { camera } = useThree();
  const metaById = useMemo(() => new Map(images.map((im) => [im.id, im])), [images]);

  // Build Float32Arrays once per points change. Three.js BufferGeometry expects
  // flat arrays; hit-testing uses the original `points` array by index.
  const { positions, colors } = useMemo(() => {
    const normalised = normalisePoints(points);
    const pos = new Float32Array(normalised.length * 3);
    const col = new Float32Array(normalised.length * 3);
    for (let i = 0; i < normalised.length; i++) {
      const p = normalised[i]!;
      pos[i * 3] = p.x;
      pos[i * 3 + 1] = p.y;
      pos[i * 3 + 2] = p.z;
      const meta = metaById.get(p.imageId);
      const [r, g, b] = meta?.palette?.[0] ? hexToRgb(meta.palette[0]) : ([0.38, 0.70, 0.93] as const);
      col[i * 3] = r;
      col[i * 3 + 1] = g;
      col[i * 3 + 2] = b;
    }
    return { positions: pos, colors: col };
  }, [points, metaById]);

  // Raycaster for hover/click. We do it manually each frame rather than using
  // r3f's onPointerOver because BufferGeometry point hit-testing in r3f fires
  // per-attribute, which is unreliable for large point clouds at small radii.
  const raycaster = useRef(new THREE.Raycaster());
  // Increase the raycaster's point intersection threshold so sparse points are
  // still pickable. Default is 0.1; 0.04 in normalised space is ~one point radius.
  raycaster.current.params.Points = { threshold: 0.04 };

  const mouseRef = useRef({ x: 0, y: 0 });
  const hoveredIdxRef = useRef<number | null>(null);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      const canvas = (e.target as HTMLElement).closest('canvas');
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      mouseRef.current = {
        x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
        y: -((e.clientY - rect.top) / rect.height) * 2 + 1
      };
    }
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, []);

  // pointsRef holds the Three.js Points object so we can raycast against it.
  // drei's <Points> exposes a THREE.Points at runtime; we only call the
  // standard THREE.Raycaster.intersectObject API on it.
  const pointsRef = useRef<THREE.Points | null>(null);

  useFrame(() => {
    if (!pointsRef.current) return;
    // Cast to THREE.Vector2 -- raycaster.setFromCamera only reads x/y which
    // mouseRef always provides; the extra Vector2 methods are not called.
    raycaster.current.setFromCamera(mouseRef.current as unknown as THREE.Vector2, camera);
    const hits = raycaster.current.intersectObject(pointsRef.current);
    const hit = hits[0];
    const newIdx = hit ? hit.index ?? null : null;
    if (newIdx !== hoveredIdxRef.current) {
      hoveredIdxRef.current = newIdx;
      const pt = newIdx !== null ? (points[newIdx] ?? null) : null;
      onHover(pt);
    }
  });

  function handleClick() {
    if (hoveredIdxRef.current === null) return;
    const pt = points[hoveredIdxRef.current];
    if (pt) onClickPoint(pt);
  }

  return (
    <Points ref={pointsRef} positions={positions} colors={colors} onClick={handleClick}>
      <PointMaterial
        vertexColors
        size={0.025}
        sizeAttenuation
        transparent
        opacity={0.85}
        depthWrite={false}
      />
    </Points>
  );
}

// Lazy thumbnail loader. Tracks camera position each frame; images within
// THUMB_LOAD_RADIUS of the camera are eagerly added to the load set. The
// hovered image id is always included so any hovered point resolves immediately
// regardless of camera distance -- without this, points far from the initial
// camera position at [0,0,4] show "loading..." forever because they fall
// outside the 2.5-unit eager radius.
function useNearbyThumbs(
  points: ManifoldPoint[],
  images: ManifoldImage[],
  hoveredId: number | null
) {
  const [loadedIds, setLoadedIds] = useState<Set<number>>(new Set());
  // We get the camera via useThree inside the Canvas. This hook must be called
  // inside the scene, not the outer component.
  const { camera } = useThree();
  const normalised = useMemo(() => normalisePoints(points), [points]);
  const frameCount = useRef(0);

  useFrame(() => {
    // Only re-check every 30 frames (~0.5s at 60fps) to avoid per-frame Set ops.
    frameCount.current++;
    if (frameCount.current % 30 !== 0) return;
    const cam = camera.position;
    const newIds: number[] = [];
    for (const p of normalised) {
      const dx = p.x - cam.x;
      const dy = p.y - cam.y;
      const dz = p.z - cam.z;
      if (dx * dx + dy * dy + dz * dz < THUMB_LOAD_RADIUS * THUMB_LOAD_RADIUS) {
        if (!loadedIds.has(p.imageId)) {
          newIds.push(p.imageId);
        }
      }
    }
    if (newIds.length > 0) {
      setLoadedIds((prev) => {
        const next = new Set(prev);
        for (const id of newIds) next.add(id);
        return next;
      });
    }
  });

  // Always include the hovered point so it loads immediately on hover
  // regardless of camera distance.
  useEffect(() => {
    if (hoveredId !== null && !loadedIds.has(hoveredId)) {
      setLoadedIds((prev) => {
        const next = new Set(prev);
        next.add(hoveredId);
        return next;
      });
    }
  }, [hoveredId, loadedIds]);

  // Return a map of id -> blobUrl for ids that should be loaded.
  const metaById = useMemo(() => new Map(images.map((im) => [im.id, im])), [images]);
  return useMemo(() => {
    const m = new Map<number, string>();
    for (const id of loadedIds) {
      const meta = metaById.get(id);
      if (meta) m.set(id, meta.blobUrl);
    }
    return m;
  }, [loadedIds, metaById]);
}

// Separate inner component so useNearbyThumbs can call useFrame (Canvas context).
type InnerProps = Props & {
  onHover: (point: ManifoldPoint | null) => void;
  onClickPoint: (point: ManifoldPoint) => void;
  onThumbsUpdate: (m: Map<number, string>) => void;
  hoveredId: number | null;
};
function SceneInner({ points, images, onHover, onClickPoint, onThumbsUpdate, hoveredId }: InnerProps) {
  const thumbs = useNearbyThumbs(points, images, hoveredId);
  useEffect(() => {
    onThumbsUpdate(thumbs);
  }, [thumbs, onThumbsUpdate]);

  return (
    <>
      <ambientLight intensity={0.4} />
      <ManifoldPoints
        points={points}
        images={images}
        onHover={onHover}
        onClickPoint={onClickPoint}
      />
      <OrbitControls
        enableDamping
        dampingFactor={0.08}
        rotateSpeed={0.6}
        zoomSpeed={0.8}
        minDistance={0.5}
        maxDistance={8}
      />
    </>
  );
}

// ----- public component (outer wrapper, no Canvas context) -----

export function ManifoldScene({ points, images }: Props) {
  const router = useRouter();
  const [hovered, setHovered] = useState<ManifoldPoint | null>(null);
  const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 });
  const [thumbs, setThumbs] = useState<Map<number, string>>(new Map());
  const metaById = useMemo(() => new Map(images.map((im) => [im.id, im])), [images]);

  const handleHover = useCallback((pt: ManifoldPoint | null) => {
    setHovered(pt);
  }, []);

  const handleClick = useCallback(
    (pt: ManifoldPoint) => {
      const meta = metaById.get(pt.imageId);
      if (meta) router.push(`/u/${meta.handle}/${meta.slug}`);
    },
    [metaById, router]
  );

  const handleThumbsUpdate = useCallback((m: Map<number, string>) => {
    setThumbs(m);
  }, []);

  // Track mouse for the overlay tooltip position (works outside Canvas).
  function onMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    setHoverPos({ x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY });
  }

  const hoveredMeta = hovered ? metaById.get(hovered.imageId) : null;
  const thumbUrl = hovered ? thumbs.get(hovered.imageId) : null;

  if (points.length === 0) {
    return (
      <div className="flex h-[600px] items-center justify-center rounded border border-ink-800 bg-ink-950 font-mono text-xs text-ink-500">
        no projection yet -- trigger recompute from{' '}
        <a href="/admin/manifold" className="ml-1 text-primary underline">
          /admin/manifold
        </a>{' '}
        once you have &ge; 4 embedded images
      </div>
    );
  }

  return (
    <div className="relative w-full select-none" style={{ height: 600 }} onMouseMove={onMouseMove}>
      <Canvas
        camera={{ position: [0, 0, 4], fov: 60 }}
        gl={{ antialias: true, alpha: false }}
        style={{ background: '#050508' }}
        className="rounded border border-ink-800"
      >
        <SceneInner
          points={points}
          images={images}
          onHover={handleHover}
          onClickPoint={handleClick}
          onThumbsUpdate={handleThumbsUpdate}
          hoveredId={hovered?.imageId ?? null}
        />
      </Canvas>

      {/* Hover tooltip -- rendered in DOM so it doesn't require a WebGL texture */}
      {hoveredMeta ? (
        <div
          className="pointer-events-none absolute z-10 overflow-hidden rounded border border-ink-800 bg-ink-950/95 shadow-lg"
          style={{
            left: Math.min(
              (typeof window !== 'undefined' ? window.innerWidth : 800) - 140,
              hoverPos.x + 14
            ),
            top: Math.max(8, hoverPos.y - 140)
          }}
        >
          {thumbUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={thumbUrl}
              alt={hoveredMeta.slug}
              width={120}
              height={120}
              className="object-cover"
              style={{ width: 120, height: 120 }}
            />
          ) : (
            <div
              className="flex items-center justify-center bg-ink-900"
              style={{ width: 120, height: 120 }}
            >
              <span className="font-mono text-[9px] text-ink-600">loading...</span>
            </div>
          )}
          <div className="border-t border-ink-800 px-2 py-1 font-mono text-[10px] text-ink-400">
            {hoveredMeta.slug}
          </div>
        </div>
      ) : null}

      <div className="pointer-events-none absolute right-2 top-2 font-mono text-[10px] text-ink-500">
        drag = orbit &middot; scroll = zoom &middot; click = open
      </div>
    </div>
  );
}
