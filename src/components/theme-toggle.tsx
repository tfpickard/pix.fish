'use client';

import { useTheme } from 'next-themes';
import { Moon, Sun, Monitor } from 'lucide-react';
import { useEffect, useState } from 'react';

const THEMES = ['system', 'dark', 'light'] as const;

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // Avoid hydration mismatch -- only render the icon once mounted on client
  useEffect(() => setMounted(true), []);

  function cycle() {
    const current = THEMES.indexOf((theme ?? 'system') as (typeof THEMES)[number]);
    setTheme(THEMES[(current + 1) % THEMES.length]);
  }

  if (!mounted) {
    return <span className="h-4 w-4" aria-hidden />;
  }

  const Icon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;
  const label =
    theme === 'dark' ? 'dark mode' : theme === 'light' ? 'light mode' : 'system theme';

  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={`${label} -- click to cycle`}
      title={label}
      className="text-ink-500 transition-colors hover:text-ink-100"
    >
      <Icon size={14} strokeWidth={1.75} />
    </button>
  );
}
