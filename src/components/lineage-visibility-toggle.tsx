'use client';

import { useState } from 'react';

// Owner control for whether /lineage is public. POSTs to the admin endpoint
// and reflects the new state optimistically.
export function LineageVisibilityToggle({ initial }: { initial: boolean }) {
  const [isPublic, setIsPublic] = useState(initial);
  const [saving, setSaving] = useState(false);

  const toggle = async () => {
    const next = !isPublic;
    setSaving(true);
    try {
      const res = await fetch('/api/admin/lineage-visibility', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ public: next })
      });
      if (res.ok) setIsPublic(next);
    } catch (err) {
      console.error('lineage visibility toggle failed', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <label className="flex items-center gap-2 font-mono text-xs text-ink-400">
      <input
        type="checkbox"
        checked={isPublic}
        onChange={toggle}
        disabled={saving}
        className="h-4 w-4 accent-primary"
      />
      public lineage graph {isPublic ? '(anyone can view)' : '(owner only)'}
    </label>
  );
}
