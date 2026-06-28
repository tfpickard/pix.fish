'use client';

import { memo } from 'react';
import type { FishFeature, FeatureShape } from './feature';
import { DEFAULT_FISH_MORPH_CONFIG, type FishMorphConfig } from '@/lib/fish/config';

// Five body outlines traced from the five reference line drawings. All share
// the exact same SVG command structure (M + 13×Q + Z = 54 numbers) so we can
// linearly interpolate between them to produce smooth organic morphing as the
// fish wanders.
//
// Path anatomy -- clockwise from chin:
//  Q1  head sweep up       Q8  tail waist
//  Q2  top of head         Q9  lower tail lobe
//  Q3  upper back          Q10 lower tail return
//  Q4  dorsal fin rise     Q11 belly right-to-mid
//  Q5  dorsal fin fall     Q12 belly mid-to-left
//  Q6  upper tail junction Q13 chin close
//  Q7  upper tail lobe

export const NUM_FISH_VARIANTS = 5;

const VARIANTS: number[][] = [
  // V0 -- balanced/standard
  // prettier-ignore
  [14,40, 4,34,8,20, 14,8,30,6, 52,2,64,10, 70,4,74,2, 80,4,76,12, 86,10,94,8, 104,16,96,26, 104,34,94,42, 102,50,90,50, 82,54,78,44, 66,54,44,54, 22,54,14,44, 10,42,14,40],

  // V1 -- plumper: belly lower, back higher, tall dorsal
  // prettier-ignore
  [12,42, 2,35,6,18, 10,5,27,3, 50,0,64,8, 70,1,74,0, 80,2,76,11, 86,8,95,6, 105,14,96,24, 105,35,94,44, 102,54,89,54, 81,57,77,46, 65,57,43,57, 21,57,12,47, 8,44,12,42],

  // V2 -- elongated: longer body, lower profile
  // prettier-ignore
  [16,38, 7,32,12,22, 19,10,36,8, 57,6,68,13, 74,7,78,5, 83,7,79,14, 88,12,94,11, 103,18,96,27, 103,35,94,42, 101,48,89,48, 81,51,78,43, 68,51,47,51, 26,51,17,42, 13,40,17,38],

  // V3 -- round head: big round front, compact body
  // prettier-ignore
  [13,40, 3,33,7,20, 10,8,22,6, 46,3,62,10, 68,4,72,2, 78,4,74,12, 84,10,92,8, 102,15,95,25, 103,33,93,41, 101,49,88,49, 80,53,76,44, 64,53,43,53, 20,53,13,44, 9,42,13,40],

  // V4 -- dramatic: very prominent fin, spread tail lobes
  // prettier-ignore
  [14,40, 4,34,8,19, 13,7,28,5, 50,1,64,9, 69,0,73,-5, 80,0,76,12, 86,9,95,5, 107,13,97,24, 105,32,95,42, 103,53,90,53, 82,57,78,44, 67,56,44,56, 22,56,14,45, 10,42,14,40],
];

function lerpCoords(a: number[], b: number[], t: number): number[] {
  return a.map((v, i) => v + (b[i] - v) * t);
}

export function buildBodyPath(morphProgress: number): string {
  const n = VARIANTS.length;
  const normalized = ((morphProgress % n) + n) % n;
  const i = Math.floor(normalized);
  const frac = normalized - i;
  const coords =
    frac === 0 ? VARIANTS[i] : lerpCoords(VARIANTS[i], VARIANTS[(i + 1) % n], frac);

  const r = (v: number) => v.toFixed(1);
  let d = `M ${r(coords[0])} ${r(coords[1])}`;
  for (let j = 2; j < coords.length; j += 4) {
    d += ` Q ${r(coords[j])} ${r(coords[j + 1])},${r(coords[j + 2])} ${r(coords[j + 3])}`;
  }
  return d + ' Z';
}

// Eye/mouth geometry. The sim drives the eye blink by writing a scaleY transform
// to the eye group (1 = open, ~0.08 = closed) and the mouth mood by writing one
// of these `d` strings to the mouth path -- both imperative, so a blinking or
// mood-changing fish never re-renders React.
export const EYE_CX = 24;
export const EYE_CY = 28;
export const MOUTH_PATHS = {
  smile: 'M 10 38 Q 14 43, 18 39',
  o: 'M 11 40 Q 13 36.5, 15 40 Q 13 43.5, 11 40',
  flat: 'M 10 40 L 17 40'
} as const;

function FeatureShapeEl({ shape }: { shape: FeatureShape }) {
  if (shape.type === 'circle') {
    return (
      <circle
        cx={shape.cx}
        cy={shape.cy}
        r={shape.r}
        fill="currentColor"
        stroke="none"
        opacity={shape.opacity}
      />
    );
  }
  return <path d={shape.d} fill="none" strokeWidth={shape.strokeWidth} opacity={shape.opacity} />;
}

interface FishSpriteProps {
  feature: FishFeature;
  // Perf gate: when false the displacement warp filter is omitted entirely and
  // the fish relies on squash/stretch only.
  warpEnabled: boolean;
  // Per-fish filter id (and turbulence seed) so each fish's warp field differs
  // and the N filters don't collide.
  filterId: string;
  turbulenceSeed: number;
  width?: number;
  config?: FishMorphConfig;
  // Ref-setters wired by the sim so its single rAF loop can mutate this fish's
  // morph transform, warp scale, body outline, eye blink, and mouth mood
  // imperatively -- no per-fish re-render.
  morphGroupRef?: (el: SVGGElement | null) => void;
  warpRef?: (el: SVGFEDisplacementMapElement | null) => void;
  bodyRef?: (el: SVGPathElement | null) => void;
  eyeRef?: (el: SVGGElement | null) => void;
  mouthRef?: (el: SVGPathElement | null) => void;
}

function FishSpriteImpl({
  feature,
  warpEnabled,
  filterId,
  turbulenceSeed,
  width = 72,
  config = DEFAULT_FISH_MORPH_CONFIG,
  morphGroupRef,
  warpRef,
  bodyRef,
  eyeRef,
  mouthRef
}: FishSpriteProps) {
  const height = (width * 65) / 110;
  // Neutral first-paint outline; the sim overrides `d` imperatively each frame.
  const initialPath = buildBodyPath(0);
  const filterOn = warpEnabled && config.warpAmount > 0;

  return (
    <svg
      viewBox="0 0 110 65"
      width={width}
      height={height}
      fill="none"
      stroke="currentColor"
      strokeWidth={3.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: 'block', overflow: 'visible' }}
    >
      {filterOn && (
        <defs>
          {/* Organic outline warp. feTurbulence is static (per-fish seed varies
              the field); the sim breathes the displacement `scale` from the
              attractor each frame, so the outline deforms without a perceptible
              loop. Region is generous and in user space so displacement up to
              the ceiling isn't clipped. */}
          <filter
            id={filterId}
            filterUnits="userSpaceOnUse"
            x={-20}
            y={-20}
            width={150}
            height={105}
          >
            <feTurbulence
              type="fractalNoise"
              baseFrequency={config.warpBaseFrequency}
              numOctaves={config.warpOctaves}
              seed={turbulenceSeed}
              result="noise"
            />
            {/* No `scale` attribute here -- it's set only imperatively. */}
            <feDisplacementMap
              ref={warpRef}
              in="SourceGraphic"
              in2="noise"
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
        </defs>
      )}

      {/* Morph group -- the sim writes scale/squash/skew (incl. baseSize) to the
          SVG `transform` ATTRIBUTE here each frame (not CSS style.transform,
          which is unreliable on WebKit/iOS). No `transform` in JSX so the
          imperative writes survive re-renders. */}
      <g ref={morphGroupRef}>
        {/* Body -- d is interpolated between the 5 variants and written by the sim. */}
        <path
          ref={bodyRef}
          d={initialPath}
          filter={filterOn ? `url(#${filterId})` : undefined}
        />

        {/* The fish's unique flourish. Inside the morph group so it tracks the
            body's squash/skew, but never warp-filtered. */}
        {feature.shapes.map((shape, i) => (
          <FeatureShapeEl key={i} shape={shape} />
        ))}

        {/* Eye -- a circle the sim squashes vertically to blink. */}
        <g ref={eyeRef}>
          <circle cx={EYE_CX} cy={EYE_CY} r={2.2} fill="currentColor" stroke="none" />
        </g>

        {/* Mouth -- the sim swaps its `d` between the mood paths. */}
        <path ref={mouthRef} d={MOUTH_PATHS.smile} strokeWidth={2.2} />
      </g>

      {/* Ground shadow -- subtle arc under the fish. Outside the morph group so
          it doesn't scale/skew. */}
      <path d="M 22 58 Q 52 62, 80 57" strokeWidth={2} opacity={0.25} />
    </svg>
  );
}

export const FishSprite = memo(FishSpriteImpl);
