import Link from 'next/link';
import { cn } from '@/lib/utils';

type Props = {
  allTags: { tag: string; count: number }[];
  activeTags: string[];
};

function buildHref(active: string[], toggle: string): string {
  const next = active.includes(toggle)
    ? active.filter((t) => t !== toggle)
    : [...active, toggle];
  if (next.length === 0) return '/';
  const params = new URLSearchParams();
  for (const t of next) params.append('tag', t);
  return `/?${params.toString()}`;
}

export function TagFilter({ allTags, activeTags }: Props) {
  if (allTags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {allTags.map(({ tag }) => {
        const isActive = activeTags.includes(tag);
        return (
          <Link
            key={tag}
            href={buildHref(activeTags, tag)}
            className={cn('chip', isActive && 'chip-active')}
          >
            {tag}
          </Link>
        );
      })}
      {activeTags.length > 0 ? (
        <Link href="/" className="chip ml-1 border-ink-500 text-ink-200">
          clear
        </Link>
      ) : null}
    </div>
  );
}
