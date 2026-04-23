import { Fraunces, JetBrains_Mono, Inter, Rubik_Wet_Paint } from 'next/font/google';

export const fontDisplay = Fraunces({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
  axes: ['SOFT', 'WONK', 'opsz']
});

// Wordmark only -- the wet, drippy shapes sell the "fish" half of pix.fish.
// Keep it out of body copy; it's unreadable at small sizes.
export const fontWordmark = Rubik_Wet_Paint({
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

export const fontSans = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap'
});
