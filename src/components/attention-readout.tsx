import { HOT_MIN_WEIGHT } from '@/lib/attention';
import type { AttentionStanding } from '@/lib/db/queries/attention';

// Below this a lifetime total rounds to "0s" -- not worth showing as all-time.
const LIFETIME_MIN_WEIGHT = 0.5;

// Format a dwell weight (roughly "seconds on screen": /api/attention credits
// ~1.0 weight per second) as a compact human duration. Sub-minute stays in
// seconds; larger totals round to minutes/hours so the lifetime figure reads.
function formatDwell(weight: number): string {
  const secs = Math.round(weight);
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 6) / 10; // one decimal hour
  return `${hours}h`;
}

// Per-image dwell readout for the detail page. Surfaces the otherwise-invisible
// attention telemetry: how much this record is being looked at lately (decayed,
// 3-day half-life), its rank by that live attention across the collection, and
// its all-time handling total. Renders nothing when the image has never drawn
// measurable dwell, so a brand-new or ignored upload shows no misleading zero.
// Aggregate + PII-free, same posture as the ingest -- nothing here identifies a
// visitor. Mirrors SurprisalReadout: plain inline flow text, no layout shift.
export function AttentionReadout({ standing }: { standing: AttentionStanding }) {
  // Gate on the same rounding threshold the labels use, so a long-since-decayed
  // sample never renders as "looked at 0s lately" or claims a live rank.
  const hotActive = standing.hot >= HOT_MIN_WEIGHT;
  const lifetimeShown = standing.lifetime >= LIFETIME_MIN_WEIGHT;
  if (!hotActive && !lifetimeShown) return null;

  return (
    <p className="text-center font-mono text-xs text-ink-500">
      {hotActive ? (
        <>
          looked at{' '}
          <span className="text-ink-300 tabular-nums">{formatDwell(standing.hot)}</span> lately
          {standing.rank ? (
            <>
              {' '}
              <span className="text-ink-300 tabular-nums">#{standing.rank}</span> of{' '}
              <span className="tabular-nums">{standing.tracked}</span>
            </>
          ) : null}
        </>
      ) : (
        <>not looked at lately</>
      )}
      {lifetimeShown ? (
        <>
          {' '}
          &middot; <span className="text-ink-300 tabular-nums">{formatDwell(standing.lifetime)}</span>{' '}
          all-time
        </>
      ) : null}
    </p>
  );
}
