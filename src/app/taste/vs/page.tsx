import type { Metadata } from 'next';
import { readNsfwMode } from '@/lib/nsfw';
import { searchByVector } from '@/lib/db/queries/embeddings';
import { hydrateNodes } from '@/lib/db/queries/daily';
import { getCaptionVectorsForIds } from '@/lib/db/queries/taste';
import { tasteVector, alignment } from '@/lib/taste/vector';
import { TasteVersus } from '@/components/taste-versus';
import type { PathNode } from '@/lib/knn-path-types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'taste · compare',
  description: 'How aligned are two aesthetics? Compare taste vectors over the gallery.',
  alternates: { canonical: '/taste/vs' },
  robots: { index: false, follow: true }
};

const MAX_IDS = 40;

function parseIds(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, MAX_IDS);
}

type PageProps = {
  searchParams: Promise<{ a?: string; as?: string; b?: string; bs?: string }>;
};

export default async function TasteVsPage({ searchParams }: PageProps) {
  const { a: rawA, as: rawAs, b: rawB, bs: rawBs } = await searchParams;
  const aPicked = parseIds(rawA);
  const aSkipped = parseIds(rawAs);
  const bPicked = parseIds(rawB);
  const bSkipped = parseIds(rawBs);
  const nsfwMode = await readNsfwMode();

  const data = await buildVersus(aPicked, aSkipped, bPicked, bSkipped, nsfwMode).catch((err) => {
    console.error('/taste/vs: buildVersus failed', err);
    return null;
  });

  if (!data) {
    return (
      <div className="space-y-4 pt-8">
        <h1 className="font-fungal-lite text-3xl text-ink-100">taste &middot; compare</h1>
        <p className="font-mono text-xs text-ink-500">
          couldn&rsquo;t read both tastes. <a href="/taste" className="text-primary hover:underline">take the quiz</a> and
          challenge a friend from your result.
        </p>
      </div>
    );
  }

  return <TasteVersus {...data} />;
}

type VersusData = {
  alignment: number;
  both: PathNode[];
  aOnly: PathNode[];
  bOnly: PathNode[];
};

async function buildVersus(
  aPicked: number[],
  aSkipped: number[],
  bPicked: number[],
  bSkipped: number[],
  nsfwMode: Awaited<ReturnType<typeof readNsfwMode>>
): Promise<VersusData | null> {
  if (aPicked.length === 0 || bPicked.length === 0) return null;
  const vecs = await getCaptionVectorsForIds([
    ...new Set([...aPicked, ...aSkipped, ...bPicked, ...bSkipped])
  ]);
  const get = (ids: number[]) => ids.map((id) => vecs.get(id)).filter((v): v is number[] => !!v);
  const aVecs = get(aPicked);
  const bVecs = get(bPicked);
  const aSkipVecs = get(aSkipped);
  const bSkipVecs = get(bSkipped);
  // Factor in what each person passed on, exactly like the solo result -- so
  // two people who picked alike but rejected opposite vibes aren't over-scored.
  const tasteA = tasteVector(aVecs, aSkipVecs);
  const tasteB = tasteVector(bVecs, bSkipVecs);
  if (!tasteA || !tasteB) return null;

  const score = alignment(tasteA, tasteB);

  // Each person's gallery, plus a blended "you'd both love" from the centroid
  // of both sets of picks. All three go through the NSFW-gated searchByVector.
  // tasteA/tasteB are non-null here so `blended` is too, but guard rather than
  // assert -- a thrown non-null would turn into the generic failure UI.
  const blended = tasteVector([...aVecs, ...bVecs], [...aSkipVecs, ...bSkipVecs]);
  const [rankedA, rankedB, rankedBoth] = await Promise.all([
    searchByVector(tasteA, { limit: 18, kind: 'caption', nsfwMode }),
    searchByVector(tasteB, { limit: 18, kind: 'caption', nsfwMode }),
    blended ? searchByVector(blended, { limit: 10, kind: 'caption', nsfwMode }) : Promise.resolve([])
  ]);

  const idsA = rankedA.map((m) => m.imageId);
  const idsB = rankedB.map((m) => m.imageId);
  const setB = new Set(idsB);
  const setA = new Set(idsA);
  const bothIds = rankedBoth.map((m) => m.imageId).slice(0, 8);
  const aOnlyIds = idsA.filter((id) => !setB.has(id)).slice(0, 4);
  const bOnlyIds = idsB.filter((id) => !setA.has(id)).slice(0, 4);

  const meta = await hydrateNodes([...new Set([...bothIds, ...aOnlyIds, ...bOnlyIds])]);
  const pick = (ids: number[]) => ids.map((id) => meta.get(id)).filter((n): n is PathNode => !!n && !!n.blobUrl);

  return { alignment: score, both: pick(bothIds), aOnly: pick(aOnlyIds), bOnly: pick(bOnlyIds) };
}
