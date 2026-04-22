export default function AdminKeysPage() {
  return (
    <div className="space-y-3">
      <h1 className="font-display text-2xl text-ink-100">api keys</h1>
      <p className="font-mono text-xs text-ink-500">wired in phase 3.</p>
      <p className="max-w-prose text-sm text-ink-300">
        Create and revoke personal access tokens for scripts posting to{' '}
        <span className="font-mono">POST /api/images</span>.
      </p>
    </div>
  );
}
