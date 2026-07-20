import { getProvider, loadUserProviderKeys } from '@/lib/ai';
import { loadAiConfig } from '@/lib/ai/loadConfig';
import { cropsByIds } from '@/lib/db/queries/character-crops';
import { getCandidate, setVerifiedGroups } from '@/lib/db/queries/character-candidates';
import { getSiteAdminId } from '@/lib/db/queries/users';
import type { Job } from '@/lib/db/schema';
import { buildMosaic } from '@/lib/images/mosaic';
import { buildVerifyPrompt, parseVerifyGroups } from '@/lib/universe/characters';

type Payload = { runStamp: number; candidateIndex: number };

// Stage 2 (per candidate): the mosaic "captcha" precision pass. Tile the
// candidate's crops into one numbered image and ask the vision model which cells
// are the SAME individual; write the confirmed same-individual subgroups back to
// staging. This is what splits a text-embedding cluster that fused different
// individuals (two frogs, two anthropomorphic fish). A permanent failure leaves
// verifiedGroups null, and the census falls back to the raw candidate. Shared by
// the job handler and the offline pipeline.
export async function verifyCandidate(runStamp: number, candidateIndex: number): Promise<void> {
  const candidate = await getCandidate(runStamp, candidateIndex);
  if (!candidate) return; // run superseded/cleared
  if (candidate.verifiedGroups) return; // already verified (idempotent)

  const cropIds = candidate.cropIds;
  if (cropIds.length <= 1) {
    await setVerifiedGroups(runStamp, candidateIndex, [cropIds]);
    return;
  }

  const crops = await cropsByIds(cropIds);
  const byId = new Map(crops.map((c) => [c.cropId, c] as const));
  // Preserve the candidate's crop-id order so mosaic cells map back correctly.
  const ordered = cropIds.map((id) => byId.get(id)).filter(Boolean) as typeof crops;
  if (ordered.length <= 1) {
    await setVerifiedGroups(runStamp, candidateIndex, [ordered.map((c) => c.cropId)]);
    return;
  }

  const cfg = await loadAiConfig();
  const keys = await loadUserProviderKeys(getSiteAdminId());
  const provider = getProvider('verify', cfg, keys);
  if (!provider?.vision) {
    // No vision provider -- can't verify. Leave null so the census keeps the
    // whole candidate as one group rather than dropping it.
    return;
  }

  const { image, mime, cells } = await buildMosaic(ordered.map((c) => c.blobUrl));
  const prompt = await buildVerifyPrompt(cells.length);
  const raw = await provider.vision(image, mime, prompt);
  const cellGroups = parseVerifyGroups(raw, cells.length);

  // Map mosaic cell indices back to crop ids: mosaic cell j corresponds to
  // ordered[cells[j]].
  const groups = cellGroups.map((g) => g.map((cell) => ordered[cells[cell]!]!.cropId));

  // Any crop the verifier never saw -- a cell whose blob failed to fetch (dropped
  // from `cells`), or a crop beyond the mosaic cap -- must not vanish. Append each
  // as its own singleton so verifiedGroups covers EVERY candidate crop: the census
  // then applies minAppearances (a stray singleton is dropped, not merged into a
  // character it wasn't verified against). Without this, an omitted crop would be
  // silently lost since the census treats a non-null verifiedGroups as complete.
  const covered = new Set(groups.flat());
  for (const c of ordered) {
    if (!covered.has(c.cropId)) groups.push([c.cropId]);
  }

  await setVerifiedGroups(runStamp, candidateIndex, groups);
}

export async function charactersVerifyHandler(job: Job): Promise<void> {
  const { runStamp, candidateIndex } = job.payload as Payload;
  await verifyCandidate(runStamp, candidateIndex);
}
