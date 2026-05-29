import { redirect } from 'next/navigation';
import { auth, isSiteAdmin } from '@/lib/auth';
import { hasAnyGrammar } from '@/lib/db/queries/grammar';
import { CARD_CATEGORIES, countCardsByCategory } from '@/lib/db/queries/constraint-cards';
import { PlaygroundClient } from './_components/playground-client';

export const dynamic = 'force-dynamic';

export default async function AdminPlayPage() {
  const session = await auth();
  if (!isSiteAdmin(session) || !session?.user?.id) redirect('/admin/upload');

  const [grammarReady, cardCounts] = await Promise.all([
    hasAnyGrammar(session.user.id),
    countCardsByCategory()
  ]);

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="font-display text-3xl text-ink-100">playground</h1>
        <p className="font-mono text-xs text-ink-500">
          a jukebox for image prompts. skeleton mines the caption grammar from your corpus and
          fills it; dice are constraint cards you can roll over a skeleton; the clipboard shows
          the result in each model dialect, one click to copy.
        </p>
        {!grammarReady && (
          <p className="font-mono text-xs text-amber-400">
            no grammar artifact for your corpus yet. run
            <code className="mx-1 rounded bg-ink-900 px-1 py-0.5 text-ink-100">
              bun scripts/derive-grammar.ts
            </code>
            (add <code className="mx-1 rounded bg-ink-900 px-1 py-0.5 text-ink-100">--llm</code>
            for a curated pass) and reload.
          </p>
        )}
      </header>
      <PlaygroundClient
        grammarReady={grammarReady}
        categories={[...CARD_CATEGORIES]}
        cardCounts={cardCounts}
      />
    </div>
  );
}
