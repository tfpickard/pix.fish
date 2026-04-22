import type { Comment } from '@/lib/db/schema';
import { CommentForm } from './comment-form';

function formatDate(d: Date | string): string {
  return new Date(d).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

export function CommentList({ slug, comments }: { slug: string; comments: Comment[] }) {
  return (
    <section aria-label="comments" className="space-y-6 border-t border-ink-800 pt-6">
      <h2 className="font-mono text-xs uppercase tracking-wide text-ink-500">comments</h2>

      {comments.length > 0 ? (
        <ul className="space-y-4">
          {comments.map((c) => (
            <li key={c.id} className="space-y-1">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-xs text-ink-100">
                  {c.authorName || 'anonymous'}
                </span>
                <span className="font-mono text-xs text-ink-500">{formatDate(c.createdAt)}</span>
              </div>
              <p className="prose-caption text-sm leading-relaxed text-ink-200">{c.body}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="font-mono text-xs text-ink-500">no comments yet -- be the first</p>
      )}

      <CommentForm slug={slug} />
    </section>
  );
}
