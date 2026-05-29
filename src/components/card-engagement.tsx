'use client';

import { ThumbsUp, ThumbsDown, MessageSquare } from 'lucide-react';
import { useReaction, type ReactionCounts } from './use-reaction';

// Compact engagement footer for gallery cards: posted date, approved-comment
// count, and interactive thumbs up/down with live counts. Lives outside the
// card's <Link> so the vote buttons don't trigger navigation -- the parent
// ImageCard wraps only the image/caption in the link.
export function CardEngagement({
  slug,
  initialCounts,
  commentCount,
  uploadedAt
}: {
  slug: string;
  initialCounts: ReactionCounts;
  commentCount: number;
  // Date from a server component, or an ISO string from the /api/images JSON
  // (infinite-scroll path). new Date() handles both.
  uploadedAt: string | Date;
}) {
  const { counts, active, pending, react } = useReaction(slug, initialCounts);
  const posted = new Date(uploadedAt).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });

  return (
    <div className="flex items-center justify-between gap-2 border-t border-ink-800/60 px-3 py-2 font-mono text-[11px] text-ink-500">
      <span>Posted {posted}</span>
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1" aria-label={`${commentCount} comments`}>
          <MessageSquare size={12} strokeWidth={1.5} />
          {commentCount}
        </span>
        <button
          type="button"
          onClick={() => react('up')}
          disabled={pending}
          aria-label={`${counts.up} upvotes`}
          className={[
            'flex items-center gap-1 transition-colors disabled:opacity-50',
            active === 'up' ? 'text-primary' : 'hover:text-primary'
          ].join(' ')}
        >
          <ThumbsUp size={12} strokeWidth={active === 'up' ? 2.5 : 1.5} />
          {counts.up}
        </button>
        <button
          type="button"
          onClick={() => react('down')}
          disabled={pending}
          aria-label={`${counts.down} downvotes`}
          className={[
            'flex items-center gap-1 transition-colors disabled:opacity-50',
            active === 'down' ? 'text-secondary' : 'hover:text-secondary'
          ].join(' ')}
        >
          <ThumbsDown size={12} strokeWidth={active === 'down' ? 2.5 : 1.5} />
          {counts.down}
        </button>
      </div>
    </div>
  );
}
