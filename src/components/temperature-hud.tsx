import { getRecentTemperatures } from '@/lib/db/queries/temperature';
import { TemperatureHudShell } from './temperature-hud-shell';

// feat/hud: server wrapper that reads the latest two collection-temperature
// readings and hands them to the dismissible client shell. Rendered once in
// the root layout. Reading two rows lets the HUD show a delta arrow without a
// client round-trip.
//
// Best-effort: a DB hiccup (or a pre-migration env without the table) must not
// blank the whole page, so the read is guarded and the HUD simply renders
// nothing when there is no data.
export async function TemperatureHud() {
  let latest = null as Awaited<ReturnType<typeof getRecentTemperatures>>[number] | null;
  let previous: number | null = null;
  try {
    const rows = await getRecentTemperatures(2);
    latest = rows[0] ?? null;
    previous = rows[1]?.value ?? null;
  } catch (err) {
    console.error('TemperatureHud: temperature read failed', err);
    return null;
  }

  if (!latest) return null;

  return (
    <TemperatureHudShell
      value={latest.value}
      previous={previous}
      pointCount={latest.pointCount}
      computedAt={latest.computedAt.toISOString()}
    />
  );
}
