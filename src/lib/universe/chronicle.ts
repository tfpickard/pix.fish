import type { UniverseEvent } from '@/lib/db/schema';
import { EVENT_TYPE } from './events';

// Pure mapping from a canon event to a chronicle entry. Shared by the
// /chronicle page and the /api/chronicle feed so both render the same thing.
// The chronicle is the institution's activity log -- it reads straight from
// the append-only events, so it never hides a contradiction or an audit flag.

export type ChronicleEntry = {
  id: number;
  type: string;
  label: string;
  at: string; // ISO timestamp
  clerk: string | null; // display name of the authoring clerk
  subjectKind: string;
  subjectId: string;
  subjectSlug: string | null; // image slug for specimen subjects (for linking)
  text: string;
};

export const CHRONICLE_EVENT_TYPES = [
  EVENT_TYPE.SpecimenIntake,
  EVENT_TYPE.DossierAmendment,
  EVENT_TYPE.AuditFlagged,
  EVENT_TYPE.DistrictIntake
];

const LABELS: Record<string, string> = {
  [EVENT_TYPE.SpecimenIntake]: 'specimen filed',
  [EVENT_TYPE.DossierAmendment]: 'dossier amended',
  [EVENT_TYPE.AuditFlagged]: 'contradiction flagged',
  [EVENT_TYPE.DistrictIntake]: 'district opened',
  [EVENT_TYPE.ClerkCommissioned]: 'clerk commissioned',
  [EVENT_TYPE.CrossReferenceFiled]: 'cross-reference filed'
};

function str(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  return typeof v === 'string' ? v : '';
}

function truncate(s: string, n = 180): string {
  const clean = s.trim().replace(/\s+/g, ' ');
  return clean.length > n ? `${clean.slice(0, n - 1)}…` : clean;
}

export type ChronicleContext = {
  slugByImageId: Map<number, string>;
  clerkNameBySlug: Map<string, string>;
};

export function toChronicleEntry(ev: UniverseEvent, ctx: ChronicleContext): ChronicleEntry {
  const payload = (ev.payload ?? {}) as Record<string, unknown>;
  const clerk = ev.authorClerk ? ctx.clerkNameBySlug.get(ev.authorClerk) ?? ev.authorClerk : null;

  let text = '';
  if (ev.type === EVENT_TYPE.SpecimenIntake || ev.type === EVENT_TYPE.DossierAmendment) {
    text = truncate(str(payload, 'dossier'));
  } else if (ev.type === EVENT_TYPE.AuditFlagged) {
    text = truncate(str(payload, 'note'));
  } else if (ev.type === EVENT_TYPE.DistrictIntake) {
    const name = str(payload, 'name');
    text = truncate([name, str(payload, 'character')].filter(Boolean).join(' -- '));
  }

  let subjectSlug: string | null = null;
  if (ev.subjectType === 'specimen') {
    const id = Number(ev.subjectId);
    subjectSlug = Number.isFinite(id) ? ctx.slugByImageId.get(id) ?? null : null;
  }

  return {
    id: ev.id,
    type: ev.type,
    label: LABELS[ev.type] ?? ev.type,
    at: new Date(ev.createdAt).toISOString(),
    clerk,
    subjectKind: ev.subjectType,
    subjectId: ev.subjectId,
    subjectSlug,
    text
  };
}
