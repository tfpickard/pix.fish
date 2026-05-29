'use client';

import { memo } from 'react';

// Inline-SVG fish, traced loosely after the line drawings in the brief: a
// rounded teardrop head on the left, a humped back, and a flowing wavy tail
// off the right. Stroke uses currentColor so the parent decides the theme
// color (light/dark via the `ink-*` tokens in globals.css).
//
// Viewbox is 100x60 with the fish facing left (head on the left). The parent
// flips horizontally by passing facing=-1 (applied as a CSS transform on the
// wrapper, not here, so the flip is animatable).

export type EyeState = 'open' | 'half' | 'closed';
export type MouthState = 'smile' | 'o' | 'flat';

interface FishSpriteProps {
  eyeState: EyeState;
  mouthState: MouthState;
  width?: number;
}

function FishSpriteImpl({ eyeState, mouthState, width = 64 }: FishSpriteProps) {
  const height = (width * 60) / 100;
  return (
    <svg
      viewBox="0 0 100 60"
      width={width}
      height={height}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: 'block', overflow: 'visible' }}
    >
      {/* Body + tail as one continuous line, like the hand drawing. Path
          starts just under the chin, sweeps around the head, up over the
          back, out into the tail fin's upper lobe, around the fin, back
          along the belly, and closes. */}
      <path
        d="
          M 12 36
          Q 6 30, 14 22
          Q 24 6, 48 10
          Q 62 12, 70 22
          Q 78 14, 92 18
          Q 98 26, 88 30
          Q 96 38, 86 44
          Q 74 46, 70 38
          Q 60 50, 36 50
          Q 18 48, 12 36
          Z
        "
      />

      {/* Eye -- swapped between open dot, half-closed line, fully closed
          line. Placed near the top-left of the head. */}
      {eyeState === 'open' && <circle cx="22" cy="28" r="1.8" fill="currentColor" stroke="none" />}
      {eyeState === 'half' && (
        <path d="M 20 28.5 Q 22 27.5, 24 28.5" strokeWidth={2} />
      )}
      {eyeState === 'closed' && <path d="M 19.5 29 L 24.5 29" strokeWidth={2} />}

      {/* Mouth -- smile (arc), o (small ring), flat (line). The mouth lives
          on the left edge under the eye. */}
      {mouthState === 'smile' && <path d="M 12 38 Q 15 41, 18 38" strokeWidth={2} />}
      {mouthState === 'o' && (
        <circle cx="14" cy="39" r="1.8" fill="none" strokeWidth={1.8} />
      )}
      {mouthState === 'flat' && <path d="M 12.5 39 L 17.5 39" strokeWidth={2} />}
    </svg>
  );
}

export const FishSprite = memo(FishSpriteImpl);
