import Link from 'next/link';
import type { Clerk, District, Specimen } from '@/lib/db/schema';
import type { CrossReferenceLink } from '@/lib/db/queries/cross-references';

// The current case file for a specimen, read from the `specimens` projection.
// Clerk-signed, dated, district-stamped, with the sources the clerk cited and
// links to the cross-referenced specimens. Server component -- pure render.

type Citation = { kind?: string; ref?: string; note?: string };

function asCitations(raw: unknown): Citation[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is Citation => typeof c === 'object' && c !== null);
}

export function DossierPanel({
  specimen,
  clerk,
  district,
  crossRefs
}: {
  specimen: Specimen;
  clerk: Clerk | null;
  district: District | null;
  crossRefs: CrossReferenceLink[];
}) {
  const filed = new Date(specimen.updatedAt).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
  const citations = asCitations(specimen.citations);

  return (
    <section
      aria-label="dossier"
      className="mx-auto max-w-2xl space-y-5 border-t border-ink-800 pt-6"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-mono text-xs uppercase tracking-wide text-ink-500">case file</h2>
        {district ? (
          <span className="font-mono text-xs text-ink-500">
            district: <span className="text-ink-300">{district.name}</span>
          </span>
        ) : null}
      </header>

      <div className="prose-caption whitespace-pre-line text-base leading-relaxed text-ink-100">
        {specimen.currentDossier}
      </div>

      {/* The clerk's signature: who filed it, for which department, when. */}
      <p className="font-mono text-xs text-ink-500">
        filed by{' '}
        <span className="text-ink-200">{clerk?.name ?? specimen.clerkSlug}</span>
        {clerk ? <>, {clerk.department}</> : null} &middot; {filed}
      </p>

      {citations.length > 0 ? (
        <div className="space-y-1">
          <h3 className="font-mono text-[0.7rem] uppercase tracking-wide text-ink-600">sources cited</h3>
          <ul className="flex flex-wrap gap-1.5">
            {citations.map((c, i) => (
              <li
                key={`${c.kind}-${c.ref}-${i}`}
                className="rounded border border-ink-800/60 px-1.5 py-0.5 font-mono text-[0.7rem] text-ink-400"
                title={c.note ?? undefined}
              >
                {c.kind ?? 'source'}: {c.ref ?? '?'}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {crossRefs.length > 0 ? (
        <div className="space-y-1">
          <h3 className="font-mono text-[0.7rem] uppercase tracking-wide text-ink-600">cross-referenced</h3>
          <ul className="flex flex-wrap gap-1.5">
            {crossRefs.map((x) => (
              <li key={x.dstImageId}>
                <Link
                  href={`/${x.dstSlug}`}
                  prefetch={false}
                  className="rounded border border-ink-800/60 px-1.5 py-0.5 font-mono text-[0.7rem] text-ink-400 underline-offset-2 hover:text-ink-100 hover:underline"
                >
                  {x.dstSlug}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
