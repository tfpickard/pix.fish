'use client';

import { ThumbsUp, ThumbsDown } from 'lucide-react';
import { useReaction, type ReactionCounts } from './use-reaction';

export function ReactionBar({ slug, initialCounts }: { slug: string; initialCounts: ReactionCounts }) {
  const { counts, active, pending, react } = useReaction(slug, initialCounts);

  return (
    <div className="flex items-center justify-center gap-6 border-t border-ink-800 pt-4">
      <button
        type="button"
        onClick={() => react('up')}
        disabled={pending}
        aria-label={`${counts.up} upvotes`}
        className={[
          'flex items-center gap-1.5 font-mono text-xs transition-colors disabled:opacity-50',
          active === 'up'
            ? 'text-primary'
            : 'text-ink-500 hover:text-primary'
        ].join(' ')}
      >
        <ThumbsUp size={13} strokeWidth={active === 'up' ? 2.5 : 1.5} />
        {counts.up > 0 ? <span>{counts.up}</span> : null}
      </button>

      <button
        type="button"
        onClick={() => react('down')}
        disabled={pending}
        aria-label={`${counts.down} downvotes`}
        className={[
          'flex items-center gap-1.5 font-mono text-xs transition-colors disabled:opacity-50',
          active === 'down'
            ? 'text-secondary'
            : 'text-ink-500 hover:text-secondary'
        ].join(' ')}
      >
        <ThumbsDown size={13} strokeWidth={active === 'down' ? 2.5 : 1.5} />
        {counts.down > 0 ? <span>{counts.down}</span> : null}
      </button>
    </div>
  );
}
