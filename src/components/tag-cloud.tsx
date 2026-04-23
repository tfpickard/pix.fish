import Link from 'next/link';

type Props = {
  tags: { tag: string; count: number }[];
  activeTags: string[];
};

// Deterministic hash so the same tag lands at the same angle/offset across
// renders (no hydration mismatch since we only use it in a Server Component).
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function TagCloud({ tags, activeTags }: Props) {
  if (tags.length === 0) return null;
  const max = Math.max(...tags.map((t) => t.count));
  const min = Math.min(...tags.map((t) => t.count));
  const scale = (n: number): number => {
    if (max === min) return 1;
    return 0.7 + ((Math.log(n + 1) - Math.log(min + 1)) / (Math.log(max + 1) - Math.log(min + 1))) * 1.4;
  };
  const weight = (n: number): number => {
    if (max === min) return 400;
    const t = (Math.log(n + 1) - Math.log(min + 1)) / (Math.log(max + 1) - Math.log(min + 1));
    return Math.round(300 + t * 500);
  };

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 py-2 font-mono leading-none text-ink-500">
      {tags.map(({ tag, count }) => {
        const active = activeTags.includes(tag);
        const next = active ? activeTags.filter((t) => t !== tag) : [...activeTags, tag];
        const params = new URLSearchParams();
        for (const t of next) params.append('tag', t);
        const href = next.length ? `/?${params.toString()}` : '/';
        const h = hash(tag);
        // -6..+6 deg tilt and -7..+7 px vertical drift; deterministic per tag.
        const rot = ((h % 13) - 6) * 0.85;
        const dy = ((h >> 4) % 15) - 7;
        return (
          <Link
            key={tag}
            href={href}
            // Expose per-tag drift as CSS custom properties; the actual
            // transform (and its hover override) lives in a tag-cloud-item
            // rule in globals.css. Writing transform directly here would
            // replace Tailwind's transform pipeline and break hover scale.
            style={
              {
                fontSize: `${scale(count)}rem`,
                fontWeight: weight(count),
                '--tag-rot': `${rot}deg`,
                '--tag-dy': `${dy}px`
              } as React.CSSProperties
            }
            className={`tag-cloud-item inline-block transition-transform ${
              active ? 'text-ink-100' : 'hover:text-ink-200'
            }`}
          >
            {tag}
          </Link>
        );
      })}
    </div>
  );
}
