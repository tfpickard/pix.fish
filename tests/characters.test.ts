import { describe, expect, test } from 'bun:test';
import { isCropFault } from '../src/lib/ai/imageEmbed';
import { parseDetectionsJson } from '../src/lib/ai/types';
import { detectCommunities } from '../src/lib/universe/cluster';
import {
  buildCropEdges,
  cropClusterVector,
  parseCharacterIdentity,
  parseVerifyGroups,
  spaceNeedsVisual
} from '../src/lib/universe/characters';

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

describe('cropClusterVector', () => {
  const crop = { vec: [3, 4], vecImage: [0, 5] }; // |vec|=5, |vecImage|=5

  test('text returns the description vec', () => {
    expect(cropClusterVector(crop, 'text', 0.5)).toEqual([3, 4]);
  });

  test('visual returns the pixel vec, null when missing', () => {
    expect(cropClusterVector(crop, 'visual', 0.5)).toEqual([0, 5]);
    expect(cropClusterVector({ vec: [1, 2], vecImage: null }, 'visual', 0.5)).toBeNull();
  });

  test('blend concatenates normalized+weighted parts; unit length', () => {
    const w = 0.5;
    const out = cropClusterVector(crop, 'blend', w)!;
    expect(out.length).toBe(4);
    // text part = normalize([3,4]) * sqrt(0.5) = [0.6,0.8]*0.7071
    expect(out[0]!).toBeCloseTo(0.6 * Math.sqrt(0.5), 5);
    expect(out[1]!).toBeCloseTo(0.8 * Math.sqrt(0.5), 5);
    // visual part = normalize([0,5]) * sqrt(0.5) = [0,1]*0.7071
    expect(out[3]!).toBeCloseTo(1 * Math.sqrt(0.5), 5);
    // the blended vector is unit-length
    const mag = Math.sqrt(out.reduce((s, x) => s + x * x, 0));
    expect(mag).toBeCloseTo(1, 5);
  });

  test('blend needs both vecs at a genuine mix weight', () => {
    expect(cropClusterVector({ vec: [1], vecImage: null }, 'blend', 0.5)).toBeNull();
    expect(cropClusterVector({ vec: [], vecImage: [1] }, 'blend', 0.5)).toBeNull();
  });

  test('degenerate blend weights collapse to a single space (no unused vec required)', () => {
    // w=0 = all text: works without a visual vec
    expect(cropClusterVector({ vec: [3, 4], vecImage: null }, 'blend', 0)).toEqual([3, 4]);
    // w=1 = all visual: works without a text vec
    expect(cropClusterVector({ vec: [], vecImage: [0, 5] }, 'blend', 1)).toEqual([0, 5]);
  });
});

describe('spaceNeedsVisual', () => {
  // The coverage gate that decides whether to enqueue a cluster at all reads
  // this; it must agree exactly with cropClusterVector about when a missing
  // vec_image would cause a crop to be dropped. Disagreement either blocks
  // clustering forever on a space that never needed visuals, or lets a run
  // through that silently prunes characters out of the canon.
  const spaces = ['text', 'visual', 'blend'] as const;
  const weights = [0, 0.25, 0.5, 1];

  test('agrees with cropClusterVector for a crop that has no visual vec', () => {
    const textOnly = { vec: [1, 0], vecImage: null };
    for (const space of spaces) {
      for (const w of weights) {
        const dropped = cropClusterVector(textOnly, space, w) === null;
        expect(spaceNeedsVisual(space, w)).toBe(dropped);
      }
    }
  });

  test('text and a zero-weight blend never need a visual vec', () => {
    expect(spaceNeedsVisual('text', 1)).toBe(false);
    expect(spaceNeedsVisual('blend', 0)).toBe(false);
    expect(spaceNeedsVisual('blend', -1)).toBe(false); // clamped to 0
  });

  test('visual and any genuine blend do', () => {
    expect(spaceNeedsVisual('visual', 0)).toBe(true);
    expect(spaceNeedsVisual('blend', 0.01)).toBe(true);
    expect(spaceNeedsVisual('blend', 1)).toBe(true);
  });
});

describe('isCropFault', () => {
  // Decides whether a failed embed spends one of a crop's bounded attempts.
  // Getting this backwards is expensive in both directions: charge the crop for
  // an outage and one Voyage incident abandons the whole corpus; excuse a dead
  // blob and it is re-billed on every pass forever.
  test('content-shaped rejections blame the crop regardless of body', () => {
    for (const s of [413, 415, 422]) expect(isCropFault(s, '')).toBe(true);
  });

  test('auth, quota, throttling and server errors are systemic', () => {
    for (const s of [401, 402, 403, 408, 429, 500, 502, 503, 529]) {
      expect(isCropFault(s, 'anything at all')).toBe(false);
    }
  });

  test('a 404 is the endpoint, not the image -- our crop URL is fetched by Voyage', () => {
    expect(isCropFault(404, 'not found')).toBe(false);
  });

  test('a 400 blames the crop only when the body is about the image', () => {
    expect(isCropFault(400, '{"detail":"Failed to download image from the provided url"}')).toBe(true);
    expect(isCropFault(400, '{"detail":"Unable to decode the image"}')).toBe(true);
    expect(isCropFault(400, '{"detail":"Image is too large"}')).toBe(true);
  });

  test('a request-level 400 is systemic even when it mentions the image', () => {
    // The exact failure that must never burn the corpus: one bad model id
    // charging every crop an attempt and abandoning all of them in three sweeps.
    expect(isCropFault(400, '{"detail":"Model voyage-multimodal-3.5 is not supported"}')).toBe(false);
    expect(
      isCropFault(400, '{"detail":"invalid model, expected one of the multimodal image models"}')
    ).toBe(false);
    expect(isCropFault(400, '{"detail":"Invalid api key"}')).toBe(false);
    expect(isCropFault(400, '{"detail":"You have exceeded your quota"}')).toBe(false);
  });

  test('an unrecognized 400 defaults to systemic', () => {
    expect(isCropFault(400, '')).toBe(false);
    expect(isCropFault(400, 'bad request')).toBe(false);
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
