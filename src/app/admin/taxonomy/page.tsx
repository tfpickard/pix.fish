export default function AdminTaxonomyPage() {
  return (
    <div className="space-y-3">
      <h1 className="font-display text-2xl text-ink-100">taxonomy</h1>
      <p className="font-mono text-xs text-ink-500">wired in phase 3.</p>
      <p className="max-w-prose text-sm text-ink-300">
        Add, remove, and reorder the structural tag taxonomy. For now edit via{' '}
        <span className="font-mono">scripts/seed.ts</span> and run{' '}
        <span className="font-mono">bun run db:seed</span>.
      </p>
    </div>
  );
}
