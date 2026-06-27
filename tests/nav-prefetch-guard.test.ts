import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression guard for the "GET / request storm" (force-dynamic prefetch loop).
//
// Root cause: every nav target is `force-dynamic`, and Next 14.2 defaults
// `staleTimes.dynamic` to 0, so an in-viewport <Link> to such a route
// re-prefetches on a loop -- each `?_rsc=` request cancelling the prior (the
// `--` GET / entries in the Vercel logs). The fix disables speculative
// prefetch on the nav links. This test fails if any nav <Link> loses its
// `prefetch={false}`, so the storm cannot silently come back.
//
// Deterministic and infra-free on purpose: it parses the source rather than
// driving a browser, so it runs in CI with no dev server or database. The
// empirical counterpart (load `/`, assert a bounded number of `/` requests in
// N seconds) lives in the Playwright spec documented in the PR; it needs a DB
// to render `/` and so is not part of this unit suite.

const ROOT = join(import.meta.dir, '..');

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

// Strip block comments before counting: the explanatory comments on the fix
// themselves mention `<Link>` and `prefetch={false}`, which would otherwise
// inflate the counts and make this guard lie.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

// Count `<Link` opening tags and `prefetch={false}` occurrences. Every nav
// Link must carry the opt-out, so the two counts must match per file.
function linkStats(source: string): { links: number; optedOut: number } {
  const code = stripComments(source);
  const links = code.match(/<Link[\s>]/g)?.length ?? 0;
  const optedOut = code.match(/prefetch=\{false\}/g)?.length ?? 0;
  return { links, optedOut };
}

describe('nav links opt out of prefetch (force-dynamic storm guard)', () => {
  for (const file of ['src/components/nav-bar.tsx', 'src/components/nav-overflow.tsx']) {
    test(`${file}: every <Link> sets prefetch={false}`, () => {
      const { links, optedOut } = linkStats(read(file));
      expect(links).toBeGreaterThan(0);
      expect(optedOut).toBe(links);
    });
  }

  test('next.config.mjs caps staleTimes.dynamic so other dynamic links cannot loop', () => {
    const cfg = read('next.config.mjs');
    expect(cfg).toContain('staleTimes');
    // dynamic must be a positive number, not the framework default of 0.
    const match = cfg.match(/staleTimes:\s*\{[^}]*dynamic:\s*(\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBeGreaterThan(0);
  });
});
