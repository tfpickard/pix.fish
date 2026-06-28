'use client';

import { memo, useCallback, useEffect, useRef, type CSSProperties } from 'react';
import { FishSprite } from './fish-sprite';
import { warpFilterId } from './lorenz';
import type { EntityView } from './entity';
import type { FishMorphConfig } from '@/lib/fish/config';
import { SPRITE_H, SPRITE_W } from './sim-config';

// One fish's React wrapper. Purely presentational: it owns the three nested
// layers the sim drives imperatively --
//   container (translate3d + z-index, written by the sim)
//     facing  (scaleX flip, written by the sim)
//       life  (enter/exit opacity+scale, the only React-driven animation)
//         <FishSprite/>
// -- and registers its DOM nodes with the sim on mount. It re-renders only when
// its view (phase) or warpEnabled/config change, never per frame.

interface FishEntityProps {
  view: EntityView;
  warpEnabled: boolean;
  config: FishMorphConfig;
  register: (id: number, refs: import('./entity').EntityRefs) => void;
  unregister: (id: number) => void;
  onScatter: (x: number, y: number) => void;
}

function FishEntityImpl({ view, warpEnabled, config, register, unregister, onScatter }: FishEntityProps) {
  const { id, feature, phase, exitKind } = view;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const facingRef = useRef<HTMLDivElement | null>(null);
  const morphGroupRef = useRef<SVGGElement | null>(null);
  const warpRef = useRef<SVGFEDisplacementMapElement | null>(null);
  const bodyRef = useRef<SVGPathElement | null>(null);
  const eyeRef = useRef<SVGGElement | null>(null);
  const mouthRef = useRef<SVGPathElement | null>(null);

  // Stable ref-setters so the sprite doesn't detach/reattach nodes each render.
  const setMorphGroup = useCallback((el: SVGGElement | null) => {
    morphGroupRef.current = el;
  }, []);
  const setWarp = useCallback((el: SVGFEDisplacementMapElement | null) => {
    warpRef.current = el;
  }, []);
  const setBody = useCallback((el: SVGPathElement | null) => {
    bodyRef.current = el;
  }, []);
  const setEye = useCallback((el: SVGGElement | null) => {
    eyeRef.current = el;
  }, []);
  const setMouth = useCallback((el: SVGPathElement | null) => {
    mouthRef.current = el;
  }, []);

  // (Re)register on mount and whenever warpEnabled flips (the warp node appears
  // or disappears, so the sim needs the fresh ref set).
  useEffect(() => {
    register(id, {
      container: containerRef.current,
      facing: facingRef.current,
      morphGroup: morphGroupRef.current,
      warp: warpRef.current,
      body: bodyRef.current,
      eye: eyeRef.current,
      mouth: mouthRef.current
    });
    return () => unregister(id);
  }, [id, warpEnabled, register, unregister]);

  const onClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      onScatter(e.clientX, e.clientY);
    },
    [onScatter]
  );

  // Enter/exit animation lives on the life layer so it never fights the sim's
  // translate (container) or facing flip (facing layer). 'burst' pops outward
  // fast; 'chomp' implodes; 'sink' was already faded to nothing by the sim as it
  // drifted down, so this just holds at zero; 'emigrate' is a soft shrink.
  const exitStyle: CSSProperties =
    exitKind === 'burst'
      ? { opacity: 0, transform: 'scale(1.9)', transitionDuration: '260ms' }
      : exitKind === 'chomp'
        ? { opacity: 0, transform: 'scale(0.15)' }
        : exitKind === 'sink'
          ? { opacity: 0, transform: 'scale(1)' }
          : { opacity: 0, transform: 'scale(0.85)' };
  const lifeStyle: CSSProperties =
    phase === 'entering'
      ? { opacity: 0, transform: 'scale(0.5)' }
      : phase === 'exiting'
        ? exitStyle
        : { opacity: 1, transform: 'scale(1)' };

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      className="pointer-events-none fixed left-0 top-0 z-30 text-ink-400"
      style={{ width: SPRITE_W, height: SPRITE_H, willChange: 'transform' }}
    >
      <div
        ref={facingRef}
        className="pointer-events-auto cursor-pointer"
        onClick={onClick}
        style={{ width: SPRITE_W, height: SPRITE_H, transition: 'transform 220ms ease-in-out' }}
      >
        <div
          className="transition-[opacity,transform] duration-500 ease-out motion-reduce:transition-none"
          style={lifeStyle}
        >
          <FishSprite
            feature={feature}
            warpEnabled={warpEnabled}
            filterId={warpFilterId(id)}
            turbulenceSeed={id}
            width={SPRITE_W}
            config={config}
            morphGroupRef={setMorphGroup}
            warpRef={setWarp}
            bodyRef={setBody}
            eyeRef={setEye}
            mouthRef={setMouth}
          />
        </div>
      </div>
    </div>
  );
}

export const FishEntity = memo(FishEntityImpl);
