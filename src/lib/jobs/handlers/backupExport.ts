import archiver from 'archiver';
import { PassThrough, Readable } from 'node:stream';
import { eq, sql } from 'drizzle-orm';
import { put } from '@vercel/blob';
import { db } from '@/lib/db/client';
import {
  aiConfig,
  captions,
  comments,
  descriptions,
  images,
  jobs,
  prompts,
  reactions,
  reports,
  savedPrompts,
  tagTaxonomy,
  tags,
  webhooks
} from '@/lib/db/schema';
import type { Job } from '@/lib/db/schema';

type Payload = { requestedBy: string };

function extFromMime(mime: string | null): string {
  if (!mime) return '.bin';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return '.jpg';
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/gif') return '.gif';
  return '.bin';
}

export async function backupExportHandler(job: Job): Promise<void> {
  const payload = job.payload as Payload;

  // Pull all tables. db.json holds everything small; blobs/ are appended
  // from streaming fetches. Secrets (api keys, webhook secrets) are omitted.
  const [
    imageRows,
    captionRows,
    descriptionRows,
    tagRows,
    taxonomyRows,
    promptRows,
    reactionRows,
    commentRows,
    reportRows,
    aiConfigRows,
    webhookRows,
    savedPromptRows
  ] = await Promise.all([
    db.select().from(images),
    db.select().from(captions),
    db.select().from(descriptions),
    db.select().from(tags),
    db.select().from(tagTaxonomy),
    db.select().from(prompts),
    db.select().from(reactions),
    db.select().from(comments),
    db.select().from(reports),
    db.select().from(aiConfig),
    db.select({ id: webhooks.id, url: webhooks.url, events: webhooks.events, active: webhooks.active, createdAt: webhooks.createdAt }).from(webhooks),
    db.select().from(savedPrompts)
  ]);

  const manifest = {
    exportedAt: new Date().toISOString(),
    schemaVersion: 1,
    requestedBy: payload.requestedBy,
    notes: 'apiKeys.keyHash and webhooks.secret are intentionally omitted from this backup.',
    counts: {
      images: imageRows.length,
      captions: captionRows.length,
      descriptions: descriptionRows.length,
      tags: tagRows.length,
      tagTaxonomy: taxonomyRows.length,
      prompts: promptRows.length,
      reactions: reactionRows.length,
      comments: commentRows.length,
      reports: reportRows.length,
      aiConfig: aiConfigRows.length,
      webhooks: webhookRows.length,
      savedPrompts: savedPromptRows.length
    }
  };

  const dbJson = {
    images: imageRows,
    captions: captionRows,
    descriptions: descriptionRows,
    tags: tagRows,
    tagTaxonomy: taxonomyRows,
    prompts: promptRows,
    reactions: reactionRows,
    comments: commentRows,
    reports: reportRows,
    aiConfig: aiConfigRows,
    webhooks: webhookRows,
    savedPrompts: savedPromptRows
  };

  const archive = archiver('zip', { zlib: { level: 6 } });
  const pass = new PassThrough();
  archive.pipe(pass);

  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
  archive.append(JSON.stringify(dbJson), { name: 'db.json' });

  for (const img of imageRows) {
    try {
      const res = await fetch(img.blobUrl);
      if (!res.ok || !res.body) continue;
      const name = `blobs/${img.slug}${extFromMime(img.mime)}`;
      // node:stream's Readable.fromWeb wraps the fetch body for archiver.
      archive.append(Readable.fromWeb(res.body as unknown as import('stream/web').ReadableStream), { name });
    } catch (err) {
      console.error('backup: failed to append blob for', img.slug, err);
    }
  }

  const done = archive.finalize();
  // @vercel/blob 0.27 only exposes `access: 'public'`, so the URL itself is
  // not ACL'd. The random suffix gives ~128 bits of entropy against blind
  // guessing, and we deliberately DO NOT return this URL to the browser --
  // /api/admin/backup/[jobId]/download streams the bytes through an
  // owner-gated endpoint so the raw URL never reaches client code.
  const blob = await put(
    `backups/${new Date().toISOString().replace(/[:.]/g, '-')}.zip`,
    pass,
    { access: 'public', addRandomSuffix: true, contentType: 'application/zip' }
  );
  await done;

  // Stash both pathname + URL on the job payload. The URL is used by the
  // server-only download route; the status route never exposes it.
  await db
    .update(jobs)
    .set({
      payload: sql`payload || ${JSON.stringify({
        resultUrl: blob.url,
        resultPathname: blob.pathname
      })}::jsonb`
    })
    .where(eq(jobs.id, job.id));
}
