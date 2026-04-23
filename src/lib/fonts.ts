import { Fraunces, JetBrains_Mono, Inter, Vampiro_One } from 'next/font/google';

export const fontDisplay = Fraunces({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
  axes: ['SOFT', 'WONK', 'opsz']
});

// Wordmark only. Vampiro One is a decorative serif with small drip-style
// ornaments on the terminals -- reads as subtly liquid without being
// obviously melty. Used only on the nav; body copy stays on Fraunces.
export const fontWordmark = Vampiro_One({
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
