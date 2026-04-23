import { sql } from 'drizzle-orm';
import { db } from '../client';

export type Stats = {
  totals: { images: number; captions: number; tags: number };
  uploadsPerWeek: { week: string; count: number }[];
  topTags: { tag: string; count: number }[];
  commentsByStatus: { status: string; count: number }[];
  reactionsByKind: { kind: string; count: number }[];
  embeddingCoverage: { embedded: number; total: number; pct: number };
  jobsByTypeStatus: { type: string; status: string; count: number }[];
  recentJobFailures: number;
  webhookSuccessRate: { status: string; count: number }[];
};

// Single round-trip helper; eight small queries run in parallel since
// they're all independent.
export async function loadStats(): Promise<Stats> {
  const [
    imageTotal,
    captionTotal,
    tagTotal,
    uploadsWeek,
    topTags,
    commentsStatus,
    reactionKinds,
    embedCoverage,
    jobsAgg,
    failedRecent,
    webhookRates
  ] = await Promise.all([
    db.execute<{ c: number }>(sql`SELECT count(*)::int AS c FROM images`),
    db.execute<{ c: number }>(sql`SELECT count(*)::int AS c FROM captions`),
    db.execute<{ c: number }>(sql`SELECT count(*)::int AS c FROM tags`),
    db.execute<{ week: string; c: number }>(sql`
      SELECT to_char(date_trunc('week', uploaded_at), 'YYYY-MM-DD') AS week, count(*)::int AS c
      FROM images
      WHERE uploaded_at > now() - interval '12 weeks'
      GROUP BY 1 ORDER BY 1 ASC
    `),
    db.execute<{ tag: string; c: number }>(sql`
      SELECT tag, count(*)::int AS c FROM tags GROUP BY tag ORDER BY c DESC LIMIT 20
    `),
    db.execute<{ status: string; c: number }>(sql`
      SELECT status, count(*)::int AS c FROM comments GROUP BY status
    `),
    db.execute<{ kind: string; c: number }>(sql`
      SELECT kind, count(*)::int AS c FROM reactions GROUP BY kind
    `),
    db.execute<{ embedded: number; total: number }>(sql`
      SELECT
        (SELECT count(*)::int FROM embeddings WHERE kind = 'caption') AS embedded,
        (SELECT count(*)::int FROM images) AS total
    `),
    db.execute<{ type: string; status: string; c: number }>(sql`
      SELECT type, status, count(*)::int AS c FROM jobs GROUP BY type, status ORDER BY type, status
    `),
    db.execute<{ c: number }>(sql`
      SELECT count(*)::int AS c FROM jobs
      WHERE status = 'failed' AND finished_at > now() - interval '24 hours'
    `),
    db.execute<{ status: string; c: number }>(sql`
      SELECT status, count(*)::int AS c FROM webhook_deliveries
      WHERE created_at > now() - interval '24 hours'
      GROUP BY status
    `)
  ]);

  const embedded = Number(embedCoverage.rows[0]?.embedded ?? 0);
  const total = Number(embedCoverage.rows[0]?.total ?? 0);

  return {
    totals: {
      images: Number(imageTotal.rows[0]?.c ?? 0),
      captions: Number(captionTotal.rows[0]?.c ?? 0),
      tags: Number(tagTotal.rows[0]?.c ?? 0)
    },
    uploadsPerWeek: uploadsWeek.rows.map((r) => ({ week: r.week, count: Number(r.c) })),
    topTags: topTags.rows.map((r) => ({ tag: r.tag, count: Number(r.c) })),
    commentsByStatus: commentsStatus.rows.map((r) => ({ status: r.status, count: Number(r.c) })),
    reactionsByKind: reactionKinds.rows.map((r) => ({ kind: r.kind, count: Number(r.c) })),
    embeddingCoverage: { embedded, total, pct: total === 0 ? 0 : embedded / total },
    jobsByTypeStatus: jobsAgg.rows.map((r) => ({ type: r.type, status: r.status, count: Number(r.c) })),
    recentJobFailures: Number(failedRecent.rows[0]?.c ?? 0),
    webhookSuccessRate: webhookRates.rows.map((r) => ({ status: r.status, count: Number(r.c) }))
  };
}
