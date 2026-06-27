'use client';

import { memo } from 'react';
import { WARP_FILTER_ID } from './lorenz';
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

export type EyeState = 'open' | 'half' | 'closed';
export type MouthState = 'smile' | 'o' | 'flat';

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

interface FishSpriteProps {
  eyeState: EyeState;
  mouthState: MouthState;
  morphProgress: number;
  width?: number;
  // Ref-setters wired by the brain hook so its rAF loop can mutate the morph
  // group's transform and the warp filter's displacement scale imperatively,
  // without re-rendering. Stable identities keep this component's memo intact.
  morphGroupRef?: (el: SVGGElement | null) => void;
  warpRef?: (el: SVGFEDisplacementMapElement | null) => void;
  // Live morph config; only the warp filter params are read here (the transform
  // is written imperatively by the brain). Defaults keep the sprite renderable
  // before the config has loaded.
  config?: FishMorphConfig;
}

function FishSpriteImpl({
  eyeState,
  mouthState,
  morphProgress,
  width = 72,
  morphGroupRef,
  warpRef,
  config = DEFAULT_FISH_MORPH_CONFIG
}: FishSpriteProps) {
  const height = (width * 65) / 110;
  const bodyPath = buildBodyPath(morphProgress);
  // At warpAmount 0 we omit the filter entirely so the zero-warp configuration
  // pays no filter cost (pure squash/stretch fallback).
  const warpEnabled = config.warpAmount > 0;

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
      {warpEnabled && (
        <defs>
          {/* Organic outline warp. feTurbulence is static; the brain breathes
              the displacement `scale` from the attractor each frame, so the
              outline deforms without a perceptible loop. Region is generous and
              in user space so displacement up to the ceiling isn't clipped. */}
          <filter
            id={WARP_FILTER_ID}
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
              result="noise"
            />
            {/* No `scale` attribute here -- it's set only imperatively, so the
                throttled morph re-render can't reset it. */}
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

      {/* Morph group -- the brain writes scale/squash/skew to the SVG `transform`
          ATTRIBUTE here each frame (not CSS style.transform, which is unreliable
          on WebKit/iOS). No `transform` in JSX so the imperative writes survive
          re-renders. */}
      <g ref={morphGroupRef}>
        {/* Body -- path d is interpolated between the 5 variants */}
        <path d={bodyPath} filter={warpEnabled ? `url(#${WARP_FILTER_ID})` : undefined} />

        {/* Eye */}
        {eyeState === 'open' && (
          <circle cx="24" cy="28" r="2.2" fill="currentColor" stroke="none" />
        )}
        {eyeState === 'half' && (
          <path d="M 21.5 28.5 Q 24 27, 26.5 28.5" strokeWidth={2.4} />
        )}
        {eyeState === 'closed' && <path d="M 21 29 L 27 29" strokeWidth={2.4} />}

        {/* Mouth */}
        {mouthState === 'smile' && (
          <path d="M 10 38 Q 14 43, 18 39" strokeWidth={2.2} />
        )}
        {mouthState === 'o' && (
          <circle cx="13" cy="40" r="2.2" fill="none" strokeWidth={2} />
        )}
        {mouthState === 'flat' && <path d="M 10 40 L 17 40" strokeWidth={2.2} />}
      </g>

      {/* Ground shadow -- subtle arc under the fish like in the reference
          drawings. Stays outside the morph group so it doesn't scale/skew. */}
      <path d="M 22 58 Q 52 62, 80 57" strokeWidth={2} opacity={0.25} />
    </svg>
  );
}

export const FishSprite = memo(FishSpriteImpl);
