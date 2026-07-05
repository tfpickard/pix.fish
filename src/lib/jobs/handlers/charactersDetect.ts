import { del, put } from '@vercel/blob';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { getEmbedder, getProvider, loadUserProviderKeys } from '@/lib/ai';
import { loadAiConfig } from '@/lib/ai/loadConfig';
import { parseDetectionsJson } from '@/lib/ai/types';
import { db } from '@/lib/db/client';
import {
  countCropsForImage,
  cropBlobKeysForImage,
  deleteCropsForImage,
  insertCharacterCrop
} from '@/lib/db/queries/character-crops';
import { images, type Job } from '@/lib/db/schema';
import { buildDetectPrompt } from '@/lib/universe/characters';

type Payload = { imageId: number; force?: boolean };

const MAX_FIGURES = 6;
const HEADSHOT_MAX = 384; // px, longest edge of the saved crop

// Clear an image's crops on a forced re-detect, deleting the Blob objects BEFORE
// the rows -- the rows hold the only copy of each crop's blob key, so dropping
// them first would orphan the public headshots beyond reach of any cleanup. If
// reading the keys or deleting the blobs fails, we DON'T delete the rows: we let
// the error propagate so the keys survive for the queue's retry, rather than
// silently orphaning the headshots. Also resets characters_detected_at: the
// image now has zero crops, so if the re-crop later throws, a non-force run must
// still see it as un-examined and retry rather than skip an empty image.
async function clearCrops(imageId: number): Promise<void> {
  const keys = await cropBlobKeysForImage(imageId);
  if (keys.length > 0) await del(keys);
  await deleteCropsForImage(imageId);
  await db.update(images).set({ charactersDetectedAt: null }).where(eq(images.id, imageId));
}

// Mark this image as examined (even when no figures were found) so non-force
// runs don't re-detect it.
async function markDetected(imageId: number): Promise<void> {
  await db.update(images).set({ charactersDetectedAt: new Date() }).where(eq(images.id, imageId));
}

// Detect the figures in one image, crop a headshot of each, embed its
// description, and store as character_crops evidence. NSFW images ARE detected:
// a character's appearances in NSFW specimens are part of their identity, so the
// canon must not censor them. Only archived images (pulled from circulation) are
// skipped. Public leakage is prevented at the DISPLAY layer, not here -- the
// character pages/queries gate NSFW crops behind the visitor's opt-in.
// Idempotent: skips an image that already has crops unless force=true.
export async function charactersDetectHandler(job: Job): Promise<void> {
  const { imageId, force = false } = job.payload as Payload;

  const [img] = await db
    .select({
      ownerId: images.ownerId,
      blobUrl: images.blobUrl,
      blobKey: images.blobKey,
      mime: images.mime,
      archivedAt: images.archivedAt,
      charactersDetectedAt: images.charactersDetectedAt
    })
    .from(images)
    .where(eq(images.id, imageId))
    .limit(1);
  if (!img) return;
  if (img.archivedAt) return; // pulled from circulation; NSFW is still detected

  // Already examined? Skip unless forced. The timestamp marker (set even when no
  // figures were found) means a figureless image isn't re-billed a vision call
  // on every later detect-all; the crop-count check keeps pre-marker rows from
  // being needlessly re-detected once after the column was added.
  if (!force && (img.charactersDetectedAt != null || (await countCropsForImage(imageId)) > 0)) return;

  const cfg = await loadAiConfig();
  // BYO keys: detection is a per-image vision+embed call, so it bills to the
  // image owner's provider (matching enrich.image / reprocess.image), not the
  // site admin's. loadUserProviderKeys falls back to env keys when the owner has
  // none, preserving the single-owner deployment.
  const keys = await loadUserProviderKeys(img.ownerId);
  const provider = getProvider('captions', cfg, keys);
  if (!provider || !provider.vision) throw new Error('characters.detect: no vision-capable provider');
  const embedder = getEmbedder(cfg, keys);
  if (!embedder) throw new Error('characters.detect: no embedder available');

  const res = await fetch(img.blobUrl);
  if (!res.ok) throw new Error(`characters.detect: fetch original ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = img.mime ?? 'image/jpeg';

  const prompt = await buildDetectPrompt();
  const raw = await provider.vision(buf, mime, prompt, img.blobUrl);
  const detections = parseDetectionsJson(raw).slice(0, MAX_FIGURES);
  if (detections.length === 0) {
    // Re-run with force should clear stale crops even when nothing is found now.
    if (force) await clearCrops(imageId);
    await markDetected(imageId); // figureless, but examined -- don't re-bill next pass
    return;
  }

  // Bake EXIF orientation into pixels ONCE, up front. The vision model reported
  // boxes against the upright image, so dimensions and extraction must both use
  // the rotated buffer; reading pre-rotation metadata would scale boxes against
  // swapped axes for 90/270-degree orientations.
  const upright = await sharp(buf).rotate().toBuffer();
  const meta = await sharp(upright).metadata();
  const imgW = meta.width ?? 0;
  const imgH = meta.height ?? 0;
  if (imgW < 2 || imgH < 2) return;

  if (force) await clearCrops(imageId);

  let idx = 0;
  for (const d of detections) {
    // Normalized box -> integer pixels, clamped inside the image.
    const left = Math.max(0, Math.min(imgW - 1, Math.round(d.box.left * imgW)));
    const top = Math.max(0, Math.min(imgH - 1, Math.round(d.box.top * imgH)));
    const width = Math.max(1, Math.min(imgW - left, Math.round(d.box.width * imgW)));
    const height = Math.max(1, Math.min(imgH - top, Math.round(d.box.height * imgH)));
    let uploadedUrl: string | null = null;
    try {
      const cropBuf = await sharp(upright)
        .extract({ left, top, width, height })
        .resize({ width: HEADSHOT_MAX, height: HEADSHOT_MAX, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
      // Embed BEFORE uploading so an embedder failure never strands a blob.
      const vec = await embedder.embed(d.description);
      // Let blob mint a unique object (random suffix) and persist the actual
      // returned pathname as the key, rather than a deterministic name that a
      // re-detect would silently overwrite or that could collide across runs.
      const blob = await put(`${img.blobKey}__char${idx}.webp`, cropBuf, {
        access: 'public',
        contentType: 'image/webp',
        addRandomSuffix: true
      });
      uploadedUrl = blob.url;
      await insertCharacterCrop({
        imageId,
        label: d.label,
        description: d.description,
        box: { left, top, width, height },
        blobUrl: blob.url,
        blobKey: blob.pathname,
        vec,
        provider: embedder.name,
        model: embedder.model
      });
      idx++;
    } catch (err) {
      console.error(`characters.detect: crop ${idx} for image ${imageId} failed`, err);
      // If the upload landed but the row write didn't, the key was never
      // persisted, so clean up the orphaned public headshot here.
      if (uploadedUrl) await del(uploadedUrl).catch(() => {});
      // best-effort per figure; continue with the rest
    }
  }

  // Figures were detected but EVERY one failed to persist (transient embed/blob/
  // DB outage). Do NOT stamp the marker -- that would make non-force runs skip
  // this image forever. Throw so the queue retries with backoff.
  if (idx === 0) {
    throw new Error(`characters.detect: all ${detections.length} figure(s) failed to persist for image ${imageId}`);
  }

  await markDetected(imageId); // at least one crop persisted; non-force runs skip it
}
