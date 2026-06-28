// Fish tank statistics: lifetime totals plus rolling windowed averages.
//
// The sim mutates a single FishStatsAccum (held in a ref, never in React) as
// life events fire and as it samples the population each frame. On a coarse
// throttle it calls snapshotStats() to produce the immutable FishStats the
// banner renders, so motion never drives a re-render -- only the ~1Hz stats
// push does. Pure data + math here; no DOM, no React.

// How far back the rolling averages look.
export const STATS_WINDOW_MS = 60_000;

// Mutable accumulator. `popSamples` and `flow` are pruned to the window each
// time the sim samples, so they stay small (a minute of ~2Hz samples).
export interface FishStatsAccum {
  startedAt: number;
  // Lifetime totals (since this tank mounted; persist across hide/show).
  born: number;
  immigrated: number;
  eaten: number;
  fights: number;
  fightKills: number;
  naturalDeaths: number;
  emigrated: number;
  peak: number;
  // Rolling-window raw data.
  popSamples: { t: number; pop: number }[];
  flow: { t: number; kind: 'arrival' | 'departure' }[];
}

// Immutable snapshot the banner renders.
export interface FishStats {
  population: number;
  peak: number;
  born: number;
  immigrated: number;
  eaten: number;
  fights: number;
  fightKills: number;
  naturalDeaths: number;
  emigrated: number;
  deaths: number;
  avgPopulation: number;
  arrivalsPerMin: number;
  departuresPerMin: number;
  windowSec: number;
}

export function newStatsAccum(now: number): FishStatsAccum {
  return {
    startedAt: now,
    born: 0,
    immigrated: 0,
    eaten: 0,
    fights: 0,
    fightKills: 0,
    naturalDeaths: 0,
    emigrated: 0,
    peak: 0,
    popSamples: [],
    flow: []
  };
}

// Record the current population and drop anything older than the window.
export function sampleStats(s: FishStatsAccum, population: number, now: number): void {
  if (population > s.peak) s.peak = population;
  s.popSamples.push({ t: now, pop: population });
  const cutoff = now - STATS_WINDOW_MS;
  while (s.popSamples.length && s.popSamples[0].t < cutoff) s.popSamples.shift();
  while (s.flow.length && s.flow[0].t < cutoff) s.flow.shift();
}

// Build the render-ready snapshot. `population` is the live count right now.
export function snapshotStats(s: FishStatsAccum, population: number, now: number): FishStats {
  const cutoff = now - STATS_WINDOW_MS;
  const samples = s.popSamples.filter((p) => p.t >= cutoff);
  const avgPopulation = samples.length
    ? samples.reduce((sum, p) => sum + p.pop, 0) / samples.length
    : population;

  // Rate over the actual elapsed span (capped at the window), so a tank that
  // just started doesn't report a misleadingly tiny per-minute number.
  const spanMs = Math.min(STATS_WINDOW_MS, Math.max(now - s.startedAt, 1));
  const perMin = (count: number) => (count / spanMs) * 60_000;
  const arrivals = s.flow.filter((f) => f.t >= cutoff && f.kind === 'arrival').length;
  const departures = s.flow.filter((f) => f.t >= cutoff && f.kind === 'departure').length;

  return {
    population,
    peak: s.peak,
    born: s.born,
    immigrated: s.immigrated,
    eaten: s.eaten,
    fights: s.fights,
    fightKills: s.fightKills,
    naturalDeaths: s.naturalDeaths,
    emigrated: s.emigrated,
    deaths: s.eaten + s.fightKills + s.naturalDeaths + s.emigrated,
    avgPopulation,
    arrivalsPerMin: perMin(arrivals),
    departuresPerMin: perMin(departures),
    windowSec: Math.round(STATS_WINDOW_MS / 1000)
  };
}
