import type { Metadata } from 'next';
import { readNsfwMode } from '@/lib/nsfw';
import { searchByVector } from '@/lib/db/queries/embeddings';
import { hydrateNodes } from '@/lib/db/queries/daily';
import {
  getRandomEmbeddedImageIds,
  getCaptionVectorsForIds,
  topTagsForImages,
  dominantPalette
} from '@/lib/db/queries/taste';
import { tasteVector } from '@/lib/taste/vector';
import { TasteQuiz } from '@/components/taste-quiz';
import { TasteResult } from '@/components/taste-result';
import type { PathNode } from '@/lib/knn-path-types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'taste',
  description:
    'Find your aesthetic as a vector: a quick this-or-that, then the gallery re-ranked as you, with a shareable signature.',
  alternates: { canonical: '/taste' },
  robots: { index: true, follow: true }
};

const ROUNDS = 10;
const MAX_IDS = 40;

// Parse a comma-separated id list from the URL, keeping only positive ints and
// capping length so a crafted URL can't fan out the work.
function parseIds(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, MAX_IDS);
}

type PageProps = {
  searchParams: Promise<{ p?: string; s?: string; vs?: string; vsk?: string }>;
};

export default async function TastePage({ searchParams }: PageProps) {
  const { p: rawP, s: rawS, vs: rawVs, vsk: rawVsk } = await searchParams;
  const picked = parseIds(rawP);
  const skipped = parseIds(rawS);
  const challenger = parseIds(rawVs);
  const challengerSkipped = parseIds(rawVsk);
  const nsfwMode = await readNsfwMode();

  // ---- Result view: a shareable URL of picks -> taste vector -> the gallery
  // re-ranked as you. Everything rendered (matches, tags, palette) is computed
  // over the NSFW-gated match set, never the raw picks, so no hidden blobUrl
  // can leak even if someone crafts the picks in the URL.
  if (picked.length > 0) {
    const result = await buildResult(picked, skipped, nsfwMode).catch((err) => {
      console.error('/taste: buildResult failed', err);
      return null;
    });
    if (result && result.matches.length > 0) {
      return <TasteResult {...result} picked={picked} skipped={skipped} />;
    }
    return (
      <div className="space-y-4 pt-8">
        <h1 className="font-fungal-lite text-3xl text-ink-100">taste</h1>
        <p className="font-mono text-xs text-ink-500">
          couldn&rsquo;t read those picks. <a href="/taste" className="text-primary hover:underline">take the quiz</a> to
          find your aesthetic.
        </p>
      </div>
    );
  }

  // ---- Quiz view: seed N this-or-that pairs from random embedded images.
  const ids = await getRandomEmbeddedImageIds(ROUNDS * 2, nsfwMode);
  const meta = await hydrateNodes(ids);
  const usable = ids.map((id) => meta.get(id)).filter((n): n is PathNode => !!n && !!n.blobUrl);

  if (usable.length < 4) {
    return (
      <div className="space-y-4 pt-8">
        <h1 className="font-fungal-lite text-3xl text-ink-100">taste</h1>
        <p className="font-mono text-xs text-ink-500">
          not enough images yet to read your taste -- check back once more have been added.
        </p>
      </div>
    );
  }

  const pairs: [PathNode, PathNode][] = [];
  for (let i = 0; i + 1 < usable.length; i += 2) {
    pairs.push([usable[i]!, usable[i + 1]!]);
  }

  return (
    <TasteQuiz
      pairs={pairs}
      vs={challenger.length ? challenger.join(',') : undefined}
      vsSkip={challengerSkipped.length ? challengerSkipped.join(',') : undefined}
    />
  );
}

type ResultData = {
  archetype: string;
  signature: string[];
  palette: string[];
  matches: PathNode[];
};

async function buildResult(picked: number[], skipped: number[], nsfwMode: Awaited<ReturnType<typeof readNsfwMode>>): Promise<ResultData | null> {
  const vecs = await getCaptionVectorsForIds([...new Set([...picked, ...skipped])]);
  const pickedVecs = picked.map((id) => vecs.get(id)).filter((v): v is number[] => !!v);
  const skippedVecs = skipped.map((id) => vecs.get(id)).filter((v): v is number[] => !!v);
  const taste = tasteVector(pickedVecs, skippedVecs);
  if (!taste) return null;

  // Rank the gallery by nearness to the taste direction; drop anything the
  // visitor explicitly passed on, then take the top matches.
  const skippedSet = new Set(skipped);
  const ranked = await searchByVector(taste, { limit: 24, kind: 'caption', nsfwMode });
  const matchIds = ranked.map((m) => m.imageId).filter((id) => !skippedSet.has(id)).slice(0, 12);

  const [matchMeta, signature, palette] = await Promise.all([
    hydrateNodes(matchIds),
    topTagsForImages(matchIds, 8),
    dominantPalette(matchIds, 6)
  ]);
  const matches = matchIds.map((id) => matchMeta.get(id)).filter((n): n is PathNode => !!n && !!n.blobUrl);

  // The "archetype" is a tag-derived signature -- the 3 most distinctive vibes
  // of your matches. (An AI-named archetype via the breed/provider flow is the
  // natural v2.)
  const sigTags = signature.map((t) => t.tag);
  const archetype = sigTags.slice(0, 3).join(' · ') || 'uncategorizable';

  return { archetype, signature: sigTags, palette, matches };
}
