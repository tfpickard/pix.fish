import { put } from '@vercel/blob';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { getEmbedder, getProvider, loadUserProviderKeys } from '@/lib/ai';
import { loadAiConfig } from '@/lib/ai/loadConfig';
import { parseDetectionsJson } from '@/lib/ai/types';
import { db } from '@/lib/db/client';
import {
  countCropsForImage,
  deleteCropsForImage,
  insertCharacterCrop
} from '@/lib/db/queries/character-crops';
import { images, type Job } from '@/lib/db/schema';
import { buildDetectPrompt } from '@/lib/universe/characters';

type Payload = { imageId: number; force?: boolean };

const MAX_FIGURES = 6;
const HEADSHOT_MAX = 384; // px, longest edge of the saved crop

// Detect the figures in one image, crop a headshot of each, embed its
// description, and store as character_crops evidence. Skips NSFW/archived
// images (their characters would leak through the public character pages).
// Idempotent: skips an image that already has crops unless force=true.
export async function charactersDetectHandler(job: Job): Promise<void> {
  const { imageId, force = false } = job.payload as Payload;

  const [img] = await db
    .select({
      ownerId: images.ownerId,
      blobUrl: images.blobUrl,
      blobKey: images.blobKey,
      mime: images.mime,
      isNsfw: images.isNsfw,
      archivedAt: images.archivedAt
    })
    .from(images)
    .where(eq(images.id, imageId))
    .limit(1);
  if (!img) return;
  if (img.archivedAt || img.isNsfw) return; // out of public circulation / hidden

  if (!force && (await countCropsForImage(imageId)) > 0) return; // already detected

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
    if (force) await deleteCropsForImage(imageId);
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

  if (force) await deleteCropsForImage(imageId);

  let idx = 0;
  for (const d of detections) {
    // Normalized box -> integer pixels, clamped inside the image.
    const left = Math.max(0, Math.min(imgW - 1, Math.round(d.box.left * imgW)));
    const top = Math.max(0, Math.min(imgH - 1, Math.round(d.box.top * imgH)));
    const width = Math.max(1, Math.min(imgW - left, Math.round(d.box.width * imgW)));
    const height = Math.max(1, Math.min(imgH - top, Math.round(d.box.height * imgH)));
    try {
      const cropBuf = await sharp(upright)
        .extract({ left, top, width, height })
        .resize({ width: HEADSHOT_MAX, height: HEADSHOT_MAX, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
      // Let blob mint a unique object (random suffix) and persist the actual
      // returned pathname as the key, rather than a deterministic name that a
      // re-detect would silently overwrite or that could collide across runs.
      const blob = await put(`${img.blobKey}__char${idx}.webp`, cropBuf, {
        access: 'public',
        contentType: 'image/webp',
        addRandomSuffix: true
      });
      const vec = await embedder.embed(d.description);
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
      // best-effort per figure; continue with the rest
    }
  }
}
