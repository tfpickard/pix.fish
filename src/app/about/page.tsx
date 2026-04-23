import { listAboutFields } from '@/lib/db/queries/about';
import type { AboutField } from '@/lib/db/schema';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function AboutPage() {
  let fields: AboutField[] = [];
  try {
    fields = await listAboutFields();
  } catch (err) {
    console.error('about page: listAboutFields failed', err);
  }

  // Render only non-empty fields so an owner who hasn't filled a section
  // yet doesn't leak an empty heading.
  const visible = fields.filter((f) => f.content.trim().length > 0);

  return (
    <article className="mx-auto max-w-2xl space-y-10 pt-10 pb-16">
      <header className="space-y-2">
        <h1 className="font-fungal-lite text-4xl text-ink-100">about</h1>
      </header>

      {visible.length === 0 ? (
        <p className="font-mono text-xs text-ink-500">
          nothing here yet.
        </p>
      ) : (
        visible.map((f) => (
          <section key={f.id} className="space-y-3">
            <h2 className="font-fungal-lite text-2xl text-ink-200">{f.label}</h2>
            <div className="prose-caption whitespace-pre-line text-base leading-relaxed text-ink-100">
              {f.content}
            </div>
          </section>
        ))
      )}
    </article>
  );
}
