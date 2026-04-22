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
        ink: {
          50: '#f5f5f4',
          100: '#e7e5e4',
          200: '#d6d3d1',
          400: '#a8a29e',
          500: '#78716c',
          700: '#44403c',
          800: '#292524',
          900: '#1c1917',
          950: '#0c0a09'
        }
      },
      typography: {}
    }
  },
  plugins: [require('tailwindcss-animate')]
};

export default config;
