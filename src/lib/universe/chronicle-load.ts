import { listClerks } from '@/lib/db/queries/clerks';
import { listRecentEvents } from '@/lib/db/queries/events';
import { imageRefsByIds, type ImageRef } from '@/lib/db/queries/images';
import type { NsfwMode } from '@/lib/nsfw';
import {
  CHRONICLE_EVENT_TYPES,
  toChronicleEntry,
  type ChronicleEntry
} from './chronicle';

// Fetches the recent canon events and resolves the bits the chronicle needs to
// render (specimen slugs + owner handles for canonical links, clerk display
// names), then maps to entries. Specimen entries are filtered through the same
// NSFW visibility rule the public gallery uses, so a hidden image's slug and
// dossier excerpt are never exposed to a default (hide) visitor. Shared by the
// /chronicle page and the /api/chronicle feed.
//
// We over-fetch (limit * 3, capped) before filtering so a run of NSFW specimens
// can't starve the visible feed.
export async function loadChronicleEntries(
  limit = 60,
  nsfwMode: NsfwMode = 'hide'
): Promise<ChronicleEntry[]> {
  const fetchLimit = Math.min(limit * 3, 200);
  const events = await listRecentEvents(fetchLimit, { types: [...CHRONICLE_EVENT_TYPES] });

  const specimenIds = events
    .filter((e) => e.subjectType === 'specimen')
    .map((e) => Number(e.subjectId))
    .filter((n) => Number.isFinite(n));

  const [refByImageId, clerks] = await Promise.all([
    imageRefsByIds([...new Set(specimenIds)]),
    listClerks()
  ]);
  const clerkNameBySlug = new Map(clerks.map((c) => [c.slug, c.name]));

  const visible = (ref: ImageRef | undefined): boolean => {
    if (!ref) return false; // specimen with no resolvable image -> drop
    if (ref.archived) return false; // soft-deleted; out of public circulation
    if (nsfwMode === 'include') return true;
    if (nsfwMode === 'only') return ref.isNsfw;
    return !ref.isNsfw; // 'hide'
  };

  const entries: ChronicleEntry[] = [];
  for (const ev of events) {
    if (ev.subjectType === 'specimen') {
      const id = Number(ev.subjectId);
      if (!visible(refByImageId.get(id))) continue;
    }
    entries.push(toChronicleEntry(ev, { refByImageId, clerkNameBySlug }));
    if (entries.length >= limit) break;
  }
  return entries;
}
