import Link from 'next/link';

type Props = {
  tags: { tag: string; count: number }[];
  activeTags: string[];
};

export function TagCloud({ tags, activeTags }: Props) {
  if (tags.length === 0) return null;
  const max = Math.max(...tags.map((t) => t.count));
  const min = Math.min(...tags.map((t) => t.count));
  const scale = (n: number): number => {
    if (max === min) return 1;
    return 0.75 + ((Math.log(n + 1) - Math.log(min + 1)) / (Math.log(max + 1) - Math.log(min + 1))) * 1.1;
  };

  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-ink-500">
      {tags.map(({ tag, count }) => {
        const active = activeTags.includes(tag);
        const next = active ? activeTags.filter((t) => t !== tag) : [...activeTags, tag];
        const params = new URLSearchParams();
        for (const t of next) params.append('tag', t);
        const href = next.length ? `/?${params.toString()}` : '/';
        return (
          <Link
            key={tag}
            href={href}
            style={{ fontSize: `${scale(count)}rem` }}
            className={active ? 'text-ink-100' : 'hover:text-ink-200'}
          >
            {tag}
          </Link>
        );
      })}
    </div>
  );
}
