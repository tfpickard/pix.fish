import { firstCaptionsByImageIds } from '@/lib/db/queries/captions';
import { listClerks } from '@/lib/db/queries/clerks';
import { listRecentEvents } from '@/lib/db/queries/events';
import {
  CHRONICLE_EVENT_TYPES,
  toChronicleEntry,
  type ChronicleEntry
} from './chronicle';

// Fetches the recent canon events and resolves the bits the chronicle needs to
// render (specimen slugs for links, clerk display names), then maps to entries.
// Shared by the /chronicle page and the /api/chronicle feed.
export async function loadChronicleEntries(limit = 60): Promise<ChronicleEntry[]> {
  const events = await listRecentEvents(limit, { types: [...CHRONICLE_EVENT_TYPES] });

  const specimenIds = events
    .filter((e) => e.subjectType === 'specimen')
    .map((e) => Number(e.subjectId))
    .filter((n) => Number.isFinite(n));

  const [snippets, clerks] = await Promise.all([
    firstCaptionsByImageIds([...new Set(specimenIds)]),
    listClerks()
  ]);

  const slugByImageId = new Map<number, string>();
  for (const [id, snip] of snippets) slugByImageId.set(id, snip.slug);
  const clerkNameBySlug = new Map(clerks.map((c) => [c.slug, c.name]));

  return events.map((ev) => toChronicleEntry(ev, { slugByImageId, clerkNameBySlug }));
}
