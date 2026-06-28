import { describe, expect, test } from 'bun:test';
import { detectCommunities, type ClusterEdge } from '../src/lib/universe/cluster';
import { parseDistrictIdentity } from '../src/lib/universe/district';
import { dedupeKey } from '../src/lib/universe/events';
import {
  selectSalientSpecimens,
  type SpecimenSalienceInput
} from '../src/lib/universe/salience';

// Pure, infra-free tests in the style of the existing suite (no DB, no server).
// The DB-bound invariants -- specimens == images, bootstrap idempotency,
// projection round-trip -- are asserted by scripts/verify-universe.ts, which
// needs a populated database and so is not part of this unit suite.

describe('detectCommunities (districts from the kNN graph)', () => {
  // Two tight triangles with no edge between them must split into two districts.
  const edges: ClusterEdge[] = [
    { src: 1, dst: 2, dist: 0.1 },
    { src: 2, dst: 1, dist: 0.1 },
    { src: 2, dst: 3, dist: 0.1 },
    { src: 3, dst: 1, dist: 0.1 },
    { src: 10, dst: 11, dist: 0.1 },
    { src: 11, dst: 12, dist: 0.1 },
    { src: 12, dst: 10, dist: 0.1 }
  ];
  const nodes = [1, 2, 3, 10, 11, 12];

  test('separates two disconnected clusters', () => {
    const communities = detectCommunities(nodes, edges);
    expect(communities.length).toBe(2);
    const members = communities.map((c) => c.memberImageIds);
    expect(members).toContainEqual([1, 2, 3]);
    expect(members).toContainEqual([10, 11, 12]);
  });

  test('is deterministic: same input yields identical output', () => {
    const a = detectCommunities(nodes, edges);
    const b = detectCommunities(nodes, edges);
    expect(a).toEqual(b);
  });

  test('district keys are stable and ordered by smallest member id', () => {
    const communities = detectCommunities(nodes, edges);
    expect(communities[0]!.key).toBe('district-0');
    expect(communities[0]!.memberImageIds[0]).toBe(1);
    expect(communities[1]!.key).toBe('district-1');
    expect(communities[1]!.memberImageIds[0]).toBe(10);
  });

  test('a node with no edges becomes its own district', () => {
    const communities = detectCommunities([1, 2, 99], [
      { src: 1, dst: 2, dist: 0.1 },
      { src: 2, dst: 1, dist: 0.1 }
    ]);
    const singleton = communities.find((c) => c.memberImageIds.length === 1);
    expect(singleton).toBeDefined();
    expect(singleton!.memberImageIds).toEqual([99]);
  });

  test('ignores edges that touch a node outside the node set', () => {
    const communities = detectCommunities([1, 2], [
      { src: 1, dst: 2, dist: 0.1 },
      { src: 1, dst: 500, dist: 0.1 }
    ]);
    expect(communities.length).toBe(1);
    expect(communities[0]!.memberImageIds).toEqual([1, 2]);
  });
});

describe('parseDistrictIdentity', () => {
  test('parses a plain JSON object', () => {
    const id = parseDistrictIdentity('{"name":"The Wet Archive","character":"It collects rain."}', 'district-0');
    expect(id.name).toBe('The Wet Archive');
    expect(id.character).toBe('It collects rain.');
  });

  test('strips ```json fences', () => {
    const raw = '```json\n{"name":"Vault 7","character":"Sealed."}\n```';
    const id = parseDistrictIdentity(raw, 'district-3');
    expect(id.name).toBe('Vault 7');
    expect(id.character).toBe('Sealed.');
  });

  test('falls back when the response is not usable', () => {
    const id = parseDistrictIdentity('not json at all', 'district-5');
    expect(id.name).toContain('5');
    expect(id.character.length).toBeGreaterThan(0);
  });
});

describe('dedupe keys (append-only idempotency contract)', () => {
  test('one stable key per logical fact', () => {
    expect(dedupeKey.clerk('voss')).toBe('clerk.commissioned:voss');
    expect(dedupeKey.district('district-2')).toBe('district.intake:district-2');
    expect(dedupeKey.specimenIntake(42)).toBe('specimen.intake:42');
    expect(dedupeKey.crossReference(3, 9)).toBe('cross_reference.filed:3:9');
  });

  test('cross-reference keys are directional', () => {
    expect(dedupeKey.crossReference(3, 9)).not.toBe(dedupeKey.crossReference(9, 3));
  });

  test('amendment keys are per-generation', () => {
    expect(dedupeKey.amendment(42, 1)).toBe('dossier.amendment:42:1');
    expect(dedupeKey.amendment(42, 1)).not.toBe(dedupeKey.amendment(42, 2));
  });
});

describe('selectSalientSpecimens (evolution-loop target selection)', () => {
  const NOW = 1_000_000_000_000;
  const base = (over: Partial<SpecimenSalienceInput> & { imageId: number }): SpecimenSalienceInput => ({
    fragments: 1,
    distinctClerks: 1,
    lastTouchedMs: NOW,
    ...over
  });

  test('is deterministic for a fixed seed', () => {
    const specimens = [base({ imageId: 1 }), base({ imageId: 2, fragments: 5 }), base({ imageId: 3 })];
    const opts = { count: 2, seed: 7, nowMs: NOW, edges: [] as ClusterEdge[] };
    expect(selectSalientSpecimens(specimens, opts)).toEqual(selectSalientSpecimens(specimens, opts));
  });

  test('returns at most `count` picks', () => {
    const specimens = Array.from({ length: 10 }, (_, i) => base({ imageId: i + 1 }));
    const picks = selectSalientSpecimens(specimens, { count: 3, seed: 1, nowMs: NOW, edges: [] });
    expect(picks.length).toBe(3);
  });

  test('under-documented specimens outrank well-documented ones', () => {
    const specimens = [base({ imageId: 1, fragments: 1 }), base({ imageId: 2, fragments: 20 })];
    const picks = selectSalientSpecimens(specimens, {
      count: 2,
      seed: 3,
      nowMs: NOW,
      edges: [],
      weights: { coverage: 1, staleness: 0, centrality: 0, tension: 0, walk: 0 }
    });
    expect(picks[0]!.imageId).toBe(1);
    expect(picks[0]!.reasons).toContain('under-documented');
  });

  test('stale specimens outrank fresh ones', () => {
    const specimens = [
      base({ imageId: 1, lastTouchedMs: NOW }),
      base({ imageId: 2, lastTouchedMs: NOW - 30 * 24 * 60 * 60 * 1000 })
    ];
    const picks = selectSalientSpecimens(specimens, {
      count: 2,
      seed: 5,
      nowMs: NOW,
      edges: [],
      weights: { coverage: 0, staleness: 1, centrality: 0, tension: 0, walk: 0 }
    });
    expect(picks[0]!.imageId).toBe(2);
    expect(picks[0]!.reasons).toContain('stale');
  });

  test('empty input yields no picks', () => {
    expect(selectSalientSpecimens([], { count: 5, seed: 1, nowMs: NOW, edges: [] })).toEqual([]);
  });

  test('ranking is independent of input row order (seeded jitter + sorted adjacency)', () => {
    const specimens = [
      base({ imageId: 1, fragments: 2 }),
      base({ imageId: 2, fragments: 1 }),
      base({ imageId: 3, fragments: 4 }),
      base({ imageId: 4, fragments: 1 })
    ];
    const edges: ClusterEdge[] = [
      { src: 1, dst: 2, dist: 0.1 },
      { src: 2, dst: 3, dist: 0.2 },
      { src: 3, dst: 4, dist: 0.1 }
    ];
    const opts = { count: 4, seed: 11, nowMs: NOW, edges };
    const forward = selectSalientSpecimens(specimens, opts).map((p) => p.imageId);
    const reversed = selectSalientSpecimens([...specimens].reverse(), opts).map((p) => p.imageId);
    expect(reversed).toEqual(forward);
  });
});
