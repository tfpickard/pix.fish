import Link from 'next/link';
import type { PublicComment } from '@/lib/db/queries/comments';
import { CommentForm } from './comment-form';

function formatDate(d: Date | string): string {
  return new Date(d).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

// Compose "City, Region" when both are present; otherwise the first non-null
// of city / region / country code. Returns null when none of the three are
// set (dev environment, or older comment rows pre-geo).
function formatGeo(
  city: string | null,
  region: string | null,
  country: string | null
): string | null {
  if (city && region) return `${city}, ${region}`;
  return city ?? region ?? country ?? null;
}

type Props = {
  slug: string;
  comments: PublicComment[];
  signedInAs?: { handle: string };
};

export function CommentList({ slug, comments, signedInAs }: Props) {
  return (
    <section aria-label="comments" className="space-y-6 border-t border-ink-800 pt-6">
      <h2 className="font-mono text-xs uppercase tracking-wide text-ink-500">comments</h2>

      {comments.length > 0 ? (
        <ul className="space-y-4">
          {comments.map((c) => (
            <li key={c.id} className="space-y-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <CommentByline author={c.author} />
                <span className="font-mono text-xs text-ink-500">
                  {formatDate(c.createdAt)}
                </span>
              </div>
              <p className="prose-caption text-sm leading-relaxed text-ink-200">{c.body}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="font-mono text-xs text-ink-500">no comments yet -- be the first</p>
      )}

      <CommentForm slug={slug} signedInAs={signedInAs} />
    </section>
  );
}

function CommentByline({ author }: { author: PublicComment['author'] }) {
  if (author.kind === 'user') {
    return (
      <Link
        href={`/u/${author.handle}`}
        className="font-mono text-xs text-ink-100 underline-offset-2 hover:underline"
      >
        @{author.handle}
      </Link>
    );
  }
  const geo = formatGeo(author.city, author.region, author.country);
  return (
    <span className="font-mono text-xs text-ink-100">
      {author.name || 'anonymous'}
      {geo ? <span className="text-ink-500"> · {geo}</span> : null}
    </span>
  );
}
