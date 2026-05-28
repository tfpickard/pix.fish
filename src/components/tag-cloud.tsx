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
  // Smaller base range than before; hover scales each word up to roughly
  // 1.8x so mousing over any tag is the primary way to read it.
  const scale = (n: number): number => {
    if (max === min) return 0.7;
    return 0.55 + ((Math.log(n + 1) - Math.log(min + 1)) / (Math.log(max + 1) - Math.log(min + 1))) * 0.55;
  };
  const weight = (n: number): number => {
    if (max === min) return 400;
    const t = (Math.log(n + 1) - Math.log(min + 1)) / (Math.log(max + 1) - Math.log(min + 1));
    return Math.round(300 + t * 400);
  };

  return (
    // Disc silhouette only at lg+ where the right-hand column gives it room.
    // Below lg the cloud renders as an ordinary centred flex-wrap block --
    // the disc can't fit ~70 tags in a 288px square, and iOS Safari's lack
    // of overflow clipping spills them across the SortBar (see
    // https://github.com/tfpickard/pix.fish iPad screenshot bug). The
    // lg:overflow-hidden guards against future tag-count growth even on
    // desktop.
    <div className="tag-cloud mx-auto w-full max-w-[18rem] rounded-md border border-ink-800/80 bg-ink-950/40 p-6 lg:aspect-square lg:overflow-hidden lg:rounded-full">
      <div className="flex h-full w-full flex-wrap content-center items-center justify-center gap-x-2.5 gap-y-2 font-mono leading-none text-ink-500">
        {tags.map(({ tag, count }) => {
          const active = activeTags.includes(tag);
          const next = active ? activeTags.filter((t) => t !== tag) : [...activeTags, tag];
          const params = new URLSearchParams();
          for (const t of next) params.append('tag', t);
          const href = next.length ? `/?${params.toString()}` : '/';
          const h = hash(tag);
          // Halved rotation range (-2.4..+2.4 deg) and halved drift
          // (-2..+2 px). The previous values plus close gap-y caused
          // mid-importance tags to visually intersect their neighbors;
          // this keeps the playful disc silhouette while letting every
          // word stay individually readable.
          const rot = ((h % 13) - 6) * 0.4;
          const dy = ((h >> 4) % 5) - 2;
          return (
            <Link
              key={tag}
              href={href}
              // Drift + rotation live as CSS custom properties applied via
              // .tag-cloud-item in globals.css so the Tailwind transform
              // pipeline composes with :hover scale.
              style={
                {
                  fontSize: `${scale(count)}rem`,
                  fontWeight: weight(count),
                  '--tag-rot': `${rot}deg`,
                  '--tag-dy': `${dy}px`
                } as React.CSSProperties
              }
              // transition + hover scale live in the .tag-cloud-item rule in
              // globals.css; keeping Tailwind transition utilities here
              // would override it with shorter durations / different easing.
              className={`tag-cloud-item inline-block ${
                active ? 'text-ink-100' : 'hover:text-ink-100'
              }`}
            >
              {tag}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
