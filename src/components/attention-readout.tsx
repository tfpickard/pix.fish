import type { AttentionStanding } from '@/lib/db/queries/attention';

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
  if (standing.hot <= 0 && standing.lifetime <= 0) return null;

  return (
    <p className="text-center font-mono text-xs text-ink-500">
      {standing.hot > 0 ? (
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
      {standing.lifetime > 0 ? (
        <>
          {' '}
          &middot; <span className="text-ink-300 tabular-nums">{formatDwell(standing.lifetime)}</span>{' '}
          all-time
        </>
      ) : null}
    </p>
  );
}
