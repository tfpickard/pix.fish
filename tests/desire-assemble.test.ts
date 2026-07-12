import { test, expect } from 'bun:test';
import { assembleRoutes, routeSignature, type AssemblyEdge } from '@/lib/desire/assemble';

const e = (srcId: number, dstId: number, value: number, lifetime = value): AssemblyEdge => ({
  srcId,
  dstId,
  value,
  lifetime
});

test('chains adjacent worn edges into one ordered corridor', () => {
  const routes = assembleRoutes([e(1, 2, 5), e(2, 3, 4), e(3, 4, 3)], { minNodes: 3 });
  expect(routes).toHaveLength(1);
  expect(routes[0]!.nodeIds).toEqual([1, 2, 3, 4]);
  // Strength is the weakest link; lifetime likewise.
  expect(routes[0]!.strength).toBe(3);
  expect(routes[0]!.lifetime).toBe(3);
});

test('extends both forward and backward from the seed edge', () => {
  // Seed is the hottest edge (2->3); it should pull in 1->2 (backward) and
  // 3->4 (forward) to form the full run.
  const routes = assembleRoutes([e(2, 3, 9), e(1, 2, 8), e(3, 4, 7)], { minNodes: 3 });
  expect(routes).toHaveLength(1);
  expect(routes[0]!.nodeIds).toEqual([1, 2, 3, 4]);
});

test('drops chains shorter than minNodes', () => {
  // A lone edge is a 2-node chain; with minNodes 3 it is not a corridor.
  expect(assembleRoutes([e(1, 2, 5)], { minNodes: 3 })).toHaveLength(0);
  // Same edge is kept when minNodes allows a 2-node route.
  expect(assembleRoutes([e(1, 2, 5)], { minNodes: 2 })).toHaveLength(1);
});

test('respects minEdgeValue -- sub-threshold edges are not walkable', () => {
  const routes = assembleRoutes([e(1, 2, 5), e(2, 3, 5), e(3, 4, 0.5)], {
    minNodes: 3,
    minEdgeValue: 1
  });
  expect(routes).toHaveLength(1);
  // The weak 3->4 edge is excluded, so the corridor stops at 3.
  expect(routes[0]!.nodeIds).toEqual([1, 2, 3]);
});

test('does not revisit a node (no cycles)', () => {
  const routes = assembleRoutes([e(1, 2, 5), e(2, 3, 4), e(3, 1, 3)], { minNodes: 3 });
  expect(routes).toHaveLength(1);
  expect(routes[0]!.nodeIds).toEqual([1, 2, 3]);
  expect(new Set(routes[0]!.nodeIds).size).toBe(3);
});

test('is deterministic regardless of input order', () => {
  const edges = [e(5, 6, 2), e(1, 2, 9), e(2, 3, 8), e(6, 7, 1.5)];
  const a = assembleRoutes(edges, { minNodes: 2 });
  const b = assembleRoutes([...edges].reverse(), { minNodes: 2 });
  expect(a.map((r) => routeSignature(r.nodeIds))).toEqual(b.map((r) => routeSignature(r.nodeIds)));
  // Strongest corridor first.
  expect(a[0]!.nodeIds).toEqual([1, 2, 3]);
});

test('caps corridor length at maxNodes', () => {
  const chain = Array.from({ length: 20 }, (_, i) => e(i + 1, i + 2, 100 - i));
  const routes = assembleRoutes(chain, { minNodes: 3, maxNodes: 5 });
  expect(routes[0]!.nodeIds.length).toBe(5);
});

test('empty / all-sub-threshold input yields no routes', () => {
  expect(assembleRoutes([])).toEqual([]);
  expect(assembleRoutes([e(1, 2, 0.1)], { minEdgeValue: 1 })).toEqual([]);
});
