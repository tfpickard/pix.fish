import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['var(--font-display)', 'ui-serif', 'Georgia', 'serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif']
      },
      colors: {
        // Semantic tokens (theme-aware, use in new components)
        bg:        'rgb(var(--background) / <alpha-value>)',
        surface:   'rgb(var(--card) / <alpha-value>)',
        border:    'rgb(var(--border) / <alpha-value>)',
        primary:   'rgb(var(--primary) / <alpha-value>)',
        secondary: 'rgb(var(--secondary) / <alpha-value>)',
        accent:    'rgb(var(--accent) / <alpha-value>)',
        fg: {
          DEFAULT: 'rgb(var(--foreground) / <alpha-value>)',
          muted:   'rgb(var(--muted-foreground) / <alpha-value>)',
        },
        // ink-* scale -- wired to CSS vars so it flips with theme.
        // Existing components using ink-* stay legible in both modes.
        ink: {
          50:  'rgb(var(--ink-50)  / <alpha-value>)',
          100: 'rgb(var(--ink-100) / <alpha-value>)',
          200: 'rgb(var(--ink-200) / <alpha-value>)',
          300: 'rgb(var(--ink-300) / <alpha-value>)',
          400: 'rgb(var(--ink-400) / <alpha-value>)',
          500: 'rgb(var(--ink-500) / <alpha-value>)',
          700: 'rgb(var(--ink-700) / <alpha-value>)',
          800: 'rgb(var(--ink-800) / <alpha-value>)',
          900: 'rgb(var(--ink-900) / <alpha-value>)',
          950: 'rgb(var(--ink-950) / <alpha-value>)',
        },
        destructive: 'rgb(var(--destructive) / <alpha-value>)',
      },
      typography: {}
    }
  },
  plugins: [require('tailwindcss-animate')]
};

export default config;
