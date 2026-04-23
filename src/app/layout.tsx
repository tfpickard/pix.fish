import type { Metadata, Viewport } from 'next';
import { fontDisplay, fontMono, fontSans, fontWordmark } from '@/lib/fonts';
import { NavBar } from '@/components/nav-bar';
import { Providers } from '@/components/providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'pix.fish',
  description: 'A personal image gallery with AI enrichment.',
  icons: {
    // Purple is the default (no media) for UAs that ignore prefers-color-
    // scheme. Dark/light variants swap via @media so the tab favicon
    // matches the user's OS theme. apple-touch-icon uses the dark variant
    // (iOS home-screen backgrounds are usually dark).
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon-dark.ico', media: '(prefers-color-scheme: dark)' },
      { url: '/favicon-light.ico', media: '(prefers-color-scheme: light)' },
      { url: '/icons/favicon-16.png', type: 'image/png', sizes: '16x16' },
      { url: '/icons/favicon-32.png', type: 'image/png', sizes: '32x32' }
    ],
    apple: '/icons/apple-touch-icon.png'
  },
  manifest: '/manifest.webmanifest'
};

export const viewport: Viewport = {
  themeColor: '#0a0a0a'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${fontDisplay.variable} ${fontMono.variable} ${fontSans.variable} ${fontWordmark.variable}`}
    >
      <body className="min-h-screen font-sans antialiased">
        <Providers>
          <NavBar />
          <main className="mx-auto w-full max-w-6xl px-4 pb-24">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
