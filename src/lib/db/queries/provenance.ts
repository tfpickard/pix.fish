import { eq } from 'drizzle-orm';
import { db } from '../client';
import { captions, descriptions, tags } from '../schema';

export type ProvenanceEntry = {
  field: 'caption' | 'description' | 'tags';
  provider: string | null;
  model: string | null;
  count: number;
};

// Per-image provider/model summary. Used by the prompt-provenance panel
// on the image detail page so visitors can see which model wrote each
// field. Fields with manual rows show provider="manual" so reprocess
// passes can tell at a glance which captions were owner-edited.
export async function getImageProvenance(imageId: number): Promise<ProvenanceEntry[]> {
  const [capRows, descRows, tagRows] = await Promise.all([
    db
      .select({
        provider: captions.provider,
        model: captions.model,
        locked: captions.locked
      })
      .from(captions)
      .where(eq(captions.imageId, imageId)),
    db
      .select({
        provider: descriptions.provider,
        model: descriptions.model,
        locked: descriptions.locked
      })
      .from(descriptions)
      .where(eq(descriptions.imageId, imageId)),
    db
      .select({ provider: tags.provider, model: tags.model })
      .from(tags)
      .where(eq(tags.imageId, imageId))
  ]);

  return [
    summarize('caption', capRows),
    summarize('description', descRows),
    summarize('tags', tagRows)
  ];
}

function summarize(
  field: ProvenanceEntry['field'],
  rows: { provider: string | null; model: string | null; locked?: boolean }[]
): ProvenanceEntry {
  // Pick the most-frequent provider/model pair for this field. Ties
  // resolve to whichever appeared first.
  const tally = new Map<string, { provider: string | null; model: string | null; n: number }>();
  for (const r of rows) {
    const key = `${r.provider ?? ''}|${r.model ?? ''}`;
    const cur = tally.get(key);
    if (cur) cur.n += 1;
    else tally.set(key, { provider: r.provider, model: r.model, n: 1 });
  }
  let best: { provider: string | null; model: string | null; n: number } | null = null;
  for (const v of tally.values()) {
    if (!best || v.n > best.n) best = v;
  }
  return {
    field,
    provider: best?.provider ?? null,
    model: best?.model ?? null,
    count: rows.length
  };
}
