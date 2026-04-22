import * as React from 'react';
import { cn } from '@/lib/utils';

export function Badge({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'inline-flex items-center rounded-full border border-ink-700 bg-ink-900 px-2 py-0.5 text-xs font-mono text-ink-400',
        className
      )}
      {...props}
    />
  );
}
