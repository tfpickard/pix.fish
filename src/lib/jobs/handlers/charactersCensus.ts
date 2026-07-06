import { getProvider, loadUserProviderKeys } from '@/lib/ai';
import { loadAiConfig } from '@/lib/ai/loadConfig';
import { cropsByIds, type CropMeta } from '@/lib/db/queries/character-crops';
import { deleteCandidatesForRun, listCandidates } from '@/lib/db/queries/character-candidates';
import { listClerks } from '@/lib/db/queries/clerks';
import { appendEvent, maxCensusRunStamp } from '@/lib/db/queries/events';
import { enqueueJob, inFlightRunJobCount } from '@/lib/db/queries/jobs';
import { getSiteAdminId } from '@/lib/db/queries/users';
import type { Job } from '@/lib/db/schema';
import { buildCharacterDossierPrompt, parseCharacterIdentity } from '@/lib/universe/characters';
import {
  EVENT_TYPE,
  SUBJECT_TYPE,
  dedupeKey,
  type CharacterCensusPayload
} from '@/lib/universe/events';
import { materializeEvent } from '@/lib/universe/materialize';

type Payload = { runStamp: number; minAppearances?: number; poll?: number };

const FALLBACK_CLERK = {
  slug: 'archivist',
  name: 'The Archivist',
  department: 'Office of Recurrence',
  voice: 'Flat and procedural.',
  agenda: 'Records what recurs; trusts pattern over intent.'
};

const MAX_POLLS = 20; // ~5 min at 15s between polls before proceeding anyway
const DOSSIER_BUDGET_MS = 35_000;

// Assemble the roster from the confirmed subgroups (a candidate that split into
// several individuals yields several characters), synthesize dossiers, file ONE
// character.census event (newest wins), and clear the run's staging. Falls back
// to the raw candidate for any group a verify job never confirmed. Shared by the
// finalizer handler and the offline pipeline.
export async function assembleCensus(runStamp: number, minAppearances: number): Promise<void> {
  // Refuse to publish a stale run: if a newer clustering pass (larger run stamp)
  // has already filed its census, appending now would clobber it, because the
  // reducer is newest-EVENT-id wins and this late append gets a higher id. Drop
  // this run's staging and bail instead. (Same run stamp = our own idempotent
  // re-run, which is fine.)
  const latest = await maxCensusRunStamp();
  if (latest !== null && latest > runStamp) {
    await deleteCandidatesForRun(runStamp);
    console.log(`characters.census: skipping stale run ${runStamp} (newer census ${latest} already filed)`);
    return;
  }

  const candidates = await listCandidates(runStamp);
  // Flatten confirmed subgroups; fall back to the raw candidate when a verify
  // job never confirmed it (null verifiedGroups).
  const groups: number[][] = [];
  for (const cand of candidates) {
    const gs = cand.verifiedGroups ?? [cand.cropIds];
    for (const g of gs) if (g.length > 0) groups.push(g);
  }

  const cfg = groups.length > 0 ? await loadAiConfig() : null;
  const keys = cfg ? await loadUserProviderKeys(getSiteAdminId()) : null;
  const provider = cfg && keys ? getProvider('captions', cfg, keys) : null;
  const clerks = groups.length > 0 ? await listClerks() : [];

  // Fetch every crop the run references in ONE query (avoids an N+1 per group,
  // which could exhaust the worker budget before dossier synthesis).
  const allCropIds = [...new Set(groups.flat())];
  const cropById = new Map((await cropsByIds(allCropIds)).map((c) => [c.cropId, c] as const));

  const startedAt = Date.now();
  const rosterChars: CharacterCensusPayload['characters'] = [];

  // Deterministic order: by each group's smallest crop id, so keys are stable.
  const sorted = groups
    .map((g) => [...g].sort((a, b) => a - b))
    .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));

  for (let i = 0; i < sorted.length; i++) {
    const cropIds = sorted[i]!;
    const crops = cropIds.map((id) => cropById.get(id)).filter(Boolean) as CropMeta[];
    if (crops.length === 0) continue;

    // One appearance per distinct image (smallest crop id wins as representative).
    const bestByImage = new Map<number, CropMeta>();
    for (const c of [...crops].sort((a, b) => a.cropId - b.cropId)) {
      if (!bestByImage.has(c.imageId)) bestByImage.set(c.imageId, c);
    }
    if (bestByImage.size < minAppearances) continue; // not recurring enough

    const key = `character-${rosterChars.length}`;
    const appearances = [...bestByImage.values()].sort((a, b) => a.imageId - b.imageId);
    const canonical = appearances[0]!;
    const clerk = clerks.length > 0 ? clerks[rosterChars.length % clerks.length]! : FALLBACK_CLERK;

    let identity = parseCharacterIdentity('', key);
    if (provider?.text && Date.now() - startedAt < DOSSIER_BUDGET_MS) {
      try {
        const prompt = await buildCharacterDossierPrompt({
          clerk: { name: clerk.name, department: clerk.department, voice: clerk.voice, agenda: clerk.agenda },
          descriptions: crops.map((c) => c.description),
          count: bestByImage.size
        });
        identity = parseCharacterIdentity(await provider.text(prompt), key);
      } catch (err) {
        console.error(`characters.census: dossier synthesis for ${key} failed`, err);
      }
    }

    rosterChars.push({
      key,
      name: identity.name,
      dossier: identity.dossier,
      clerkSlug: clerk.slug,
      canonicalCropUrl: canonical.blobUrl,
      appearances: appearances.map((a) => ({ imageId: a.imageId, cropUrl: a.blobUrl, box: a.box }))
    });
  }

  const { event } = await appendEvent({
    type: EVENT_TYPE.CharacterCensus,
    subjectType: SUBJECT_TYPE.Census,
    subjectId: String(runStamp),
    authorClerk: null,
    payload: { characters: rosterChars } as unknown as Record<string, unknown>,
    dedupeKey: dedupeKey.census(runStamp)
  });
  await materializeEvent(event);
  await deleteCandidatesForRun(runStamp);

  console.log(
    `characters.census: ${rosterChars.length} recurring character(s) from ${candidates.length} candidate(s)`
  );
}

// Stage 3 finalizer (job handler): barrier on the verify jobs, then assemble.
export async function charactersCensusHandler(job: Job): Promise<void> {
  const { runStamp, minAppearances = 2, poll = 0 } = job.payload as Payload;

  // Barrier: wait until no verify jobs for this run are pending/processing.
  const inFlight = await inFlightRunJobCount('characters.verify', runStamp);
  if (inFlight > 0 && poll < MAX_POLLS) {
    await enqueueJob({
      type: 'characters.census',
      payload: { runStamp, minAppearances, poll: poll + 1 },
      runAt: new Date(Date.now() + 15_000),
      maxAttempts: 3
    });
    return;
  }

  await assembleCensus(runStamp, minAppearances);
}
