import { getProvider, loadUserProviderKeys } from '@/lib/ai';
import { loadAiConfig } from '@/lib/ai/loadConfig';
import { allCropVectors, type CropVector } from '@/lib/db/queries/character-crops';
import { listClerks } from '@/lib/db/queries/clerks';
import { appendEvent } from '@/lib/db/queries/events';
import { getSiteAdminId } from '@/lib/db/queries/users';
import type { Job } from '@/lib/db/schema';
import {
  buildCharacterDossierPrompt,
  buildCropEdges,
  parseCharacterIdentity
} from '@/lib/universe/characters';
import { detectCommunities } from '@/lib/universe/cluster';
import {
  EVENT_TYPE,
  SUBJECT_TYPE,
  dedupeKey,
  type CharacterCensusPayload
} from '@/lib/universe/events';
import { materializeEvent } from '@/lib/universe/materialize';

type Payload = { minAppearances?: number; stamp?: number };

// Fallback clerk if the roster hasn't been commissioned (universe not
// bootstrapped). Keeps the census authorable rather than crashing.
const FALLBACK_CLERK = {
  slug: 'archivist',
  name: 'The Archivist',
  department: 'Office of Recurrence',
  voice: 'Flat and procedural.',
  agenda: 'Records what recurs; trusts pattern over intent.'
};

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    ma += a[i]! * a[i]!;
    mb += b[i]! * b[i]!;
  }
  const d = Math.sqrt(ma) * Math.sqrt(mb);
  return d === 0 ? 1 : 1 - dot / d;
}

function centroid(vecs: number[][]): number[] {
  const n = vecs.length;
  const dim = vecs[0]!.length;
  const c = new Array(dim).fill(0);
  for (const v of vecs) for (let i = 0; i < dim; i++) c[i] += v[i]!;
  for (let i = 0; i < dim; i++) c[i] /= n;
  return c;
}

// The census: cluster all crop embeddings into recurring characters, synthesize
// a clerk dossier for each, and file ONE character.census event (newest wins).
export async function charactersClusterHandler(job: Job): Promise<void> {
  const payload = (job.payload ?? {}) as Payload;
  const minAppearances = Math.max(2, Math.trunc(payload.minAppearances ?? 2));
  const stamp = payload.stamp ?? Math.floor(Date.now() % 2_147_483_647);

  const crops = await allCropVectors();
  if (crops.length < 2) return;

  const byCrop = new Map<number, CropVector>(crops.map((c) => [c.cropId, c]));
  const edges = buildCropEdges(crops.map((c) => ({ cropId: c.cropId, vec: c.vec })));
  const communities = detectCommunities(
    crops.map((c) => c.cropId),
    edges
  );

  const cfg = await loadAiConfig();
  const keys = await loadUserProviderKeys(getSiteAdminId());
  const provider = getProvider('captions', cfg, keys);
  const clerks = await listClerks();

  // Build the roster, keeping only communities that recur across >= N distinct
  // specimens, ordered by smallest member crop id for stable keys.
  const kept = communities
    .map((c) => c.memberImageIds) // these are crop ids
    .filter((memberCropIds) => {
      const imageIds = new Set(memberCropIds.map((id) => byCrop.get(id)?.imageId));
      imageIds.delete(undefined as unknown as number);
      return imageIds.size >= minAppearances;
    });

  const rosterChars: CharacterCensusPayload['characters'] = [];
  for (let i = 0; i < kept.length; i++) {
    const memberCropIds = kept[i]!;
    const members = memberCropIds.map((id) => byCrop.get(id)!).filter(Boolean);
    if (members.length === 0) continue;

    const c = centroid(members.map((m) => m.vec));
    // One appearance per distinct image: the crop nearest the centroid wins.
    const bestByImage = new Map<number, { crop: CropVector; dist: number }>();
    for (const m of members) {
      const dist = cosine(m.vec, c);
      const prev = bestByImage.get(m.imageId);
      if (!prev || dist < prev.dist) bestByImage.set(m.imageId, { crop: m, dist });
    }
    const appearances = [...bestByImage.values()].sort((a, b) => a.crop.imageId - b.crop.imageId);
    const canonical = [...bestByImage.values()].sort((a, b) => a.dist - b.dist)[0]?.crop ?? members[0]!;

    const clerk = clerks.length > 0 ? clerks[i % clerks.length]! : FALLBACK_CLERK;

    let identity = parseCharacterIdentity('', `character-${i}`);
    if (provider?.text) {
      try {
        const prompt = await buildCharacterDossierPrompt({
          clerk: { name: clerk.name, department: clerk.department, voice: clerk.voice, agenda: clerk.agenda },
          descriptions: members.map((m) => m.description),
          count: bestByImage.size
        });
        identity = parseCharacterIdentity(await provider.text(prompt), `character-${i}`);
      } catch (err) {
        console.error(`characters.cluster: dossier synthesis for character-${i} failed`, err);
      }
    }

    rosterChars.push({
      key: `character-${i}`,
      name: identity.name,
      dossier: identity.dossier,
      clerkSlug: clerk.slug,
      canonicalCropUrl: canonical.blobUrl,
      appearances: appearances.map((a) => ({
        imageId: a.crop.imageId,
        cropUrl: a.crop.blobUrl,
        box: a.crop.box
      }))
    });
  }

  const { event } = await appendEvent({
    type: EVENT_TYPE.CharacterCensus,
    subjectType: SUBJECT_TYPE.Census,
    subjectId: String(stamp),
    authorClerk: null,
    payload: { characters: rosterChars } as unknown as Record<string, unknown>,
    dedupeKey: dedupeKey.census(stamp)
  });
  await materializeEvent(event);

  console.log(
    `characters.cluster: ${rosterChars.length} recurring character(s) from ${crops.length} crops`
  );
}
