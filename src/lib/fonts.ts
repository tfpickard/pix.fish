import { Fraunces, JetBrains_Mono, DM_Sans, Monoton } from 'next/font/google';

export const fontDisplay = Fraunces({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
  axes: ['SOFT', 'WONK', 'opsz']
});

// Wordmark only. Monoton is a decorative retro sign face -- thin triple-
// line strokes, art-deco / vintage-neon character. Reads as weird but
// legible at display size; body copy stays on Fraunces.
export const fontWordmark = Monoton({
  subsets: ['latin'],
  variable: '--font-wordmark',
  display: 'swap',
  weight: '400'
});

export const fontMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap'
});

// DM Sans over Inter: warmer, punchier, slightly more humanist at body
// sizes while staying neutral enough for ui chrome. The CSS variable
// name (`--font-sans`) is unchanged so all consumers update
// transparently.
export const fontSans = DM_Sans({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap'
});
