import { UploadZone } from '@/components/upload-zone';

export const dynamic = 'force-dynamic';

export default function UploadPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-display text-2xl text-ink-100">upload</h1>
        <p className="font-mono text-xs text-ink-500">
          synchronous enrichment. captions, descriptions, tags.
        </p>
      </header>
      <UploadZone />
    </div>
  );
}
