import { Fraunces, JetBrains_Mono, Inter } from 'next/font/google';

export const fontDisplay = Fraunces({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
  axes: ['SOFT', 'WONK', 'opsz']
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
