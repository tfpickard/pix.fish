import { describe, expect, test } from 'bun:test';
import { parseDetectionsJson } from '../src/lib/ai/types';
import { detectCommunities } from '../src/lib/universe/cluster';
import { buildCropEdges, parseCharacterIdentity, parseVerifyGroups } from '../src/lib/universe/characters';

// Pure, infra-free tests in the existing style. The DB-bound invariants
// (crops/characters reconcile, rebuild round-trip) are asserted by
// scripts/verify-characters.ts against a populated database.

describe('parseDetectionsJson', () => {
  test('parses figures with normalized boxes', () => {
    const raw = JSON.stringify({
      figures: [
        { label: 'the analyst', description: 'a balding man in a cardigan', box: { left: 0.1, top: 0.2, width: 0.3, height: 0.4 } }
      ]
    });
    const out = parseDetectionsJson(raw);
    expect(out.length).toBe(1);
    expect(out[0]!.label).toBe('the analyst');
    expect(out[0]!.box).toEqual({ left: 0.1, top: 0.2, width: 0.3, height: 0.4 });
  });

  test('strips ```json fences', () => {
    const raw = '```json\n{"figures":[{"label":"x","description":"d","box":{"left":0,"top":0,"width":0.5,"height":0.5}}]}\n```';
    expect(parseDetectionsJson(raw).length).toBe(1);
  });

  test('clamps a box that runs past the edge', () => {
    const raw = JSON.stringify({
      figures: [{ label: 'x', description: 'd', box: { left: 0.8, top: 0.8, width: 0.5, height: 0.5 } }]
    });
    const b = parseDetectionsJson(raw)[0]!.box;
    expect(b.left + b.width).toBeLessThanOrEqual(1.0001);
    expect(b.top + b.height).toBeLessThanOrEqual(1.0001);
  });

  test('drops entries missing label/description/box', () => {
    const raw = JSON.stringify({
      figures: [
        { label: 'ok', description: 'd', box: { left: 0, top: 0, width: 0.5, height: 0.5 } },
        { label: 'no box', description: 'd' },
        { description: 'no label', box: { left: 0, top: 0, width: 0.1, height: 0.1 } }
      ]
    });
    expect(parseDetectionsJson(raw).length).toBe(1);
  });

  test('empty/garbage yields no detections', () => {
    expect(parseDetectionsJson('{"figures":[]}')).toEqual([]);
    expect(parseDetectionsJson('not json')).toEqual([]);
  });
});

describe('buildCropEdges + community detection', () => {
  // Two tight clusters of identical-ish vectors should fall into two characters.
  const mk = (cropId: number, base: number) => ({
    cropId,
    vec: Array.from({ length: 8 }, (_, i) => (i === base ? 1 : 0.01))
  });
  const crops = [mk(1, 0), mk(2, 0), mk(3, 0), mk(11, 4), mk(12, 4), mk(13, 4)];

  test('is deterministic', () => {
    expect(buildCropEdges(crops, 3)).toEqual(buildCropEdges(crops, 3));
  });

  test('separates two visual clusters into two communities', () => {
    const edges = buildCropEdges(crops, 2);
    const communities = detectCommunities(
      crops.map((c) => c.cropId),
      edges
    );
    expect(communities.length).toBe(2);
    const sizes = communities.map((c) => c.memberImageIds.length).sort();
    expect(sizes).toEqual([3, 3]);
  });
});

describe('parseCharacterIdentity', () => {
  test('parses name + dossier', () => {
    const id = parseCharacterIdentity('{"name":"The Analyst","dossier":"Always seated."}', 'character-0');
    expect(id.name).toBe('The Analyst');
    expect(id.dossier).toBe('Always seated.');
  });

  test('falls back on garbage', () => {
    const id = parseCharacterIdentity('???', 'character-7');
    expect(id.name).toContain('7');
    expect(id.dossier.length).toBeGreaterThan(0);
  });
});

describe('parseVerifyGroups', () => {
  test('parses split groups and converts 1-based cells to 0-based', () => {
    const groups = parseVerifyGroups('{"groups":[[1,3],[2]]}', 3);
    expect(groups).toEqual([
      [0, 2],
      [1]
    ]);
  });

  test('appends omitted cells as their own singletons (total partition)', () => {
    const groups = parseVerifyGroups('{"groups":[[1,2]]}', 4);
    // cells 3 and 4 (0-based 2,3) were dropped by the model -> singletons
    expect(groups).toEqual([[0, 1], [2], [3]]);
  });

  test('dedupes a cell claimed by two groups (first wins)', () => {
    const groups = parseVerifyGroups('{"groups":[[1,2],[2,3]]}', 3);
    expect(groups).toEqual([
      [0, 1],
      [2]
    ]);
  });

  test('clamps out-of-range cells and survives garbage', () => {
    expect(parseVerifyGroups('{"groups":[[1,9]]}', 2)).toEqual([[0], [1]]);
    // unparseable -> every cell becomes its own singleton
    expect(parseVerifyGroups('not json', 2)).toEqual([[0], [1]]);
  });
});
