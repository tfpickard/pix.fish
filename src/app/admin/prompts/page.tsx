export default function AdminPromptsPage() {
  return (
    <div className="space-y-3">
      <h1 className="font-display text-2xl text-ink-100">prompts</h1>
      <p className="font-mono text-xs text-ink-500">wired in phase 3.</p>
      <p className="max-w-prose text-sm text-ink-300">
        This page will let you edit the caption, description, and tags prompt templates live.
        Placeholders supported: {`{{tag_taxonomy}}`}, {`{{existing_caption}}`},{' '}
        {`{{variant_number}}`}.
      </p>
    </div>
  );
}
