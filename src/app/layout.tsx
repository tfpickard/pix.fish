import type { Metadata, Viewport } from 'next';
import { fontDisplay, fontMono, fontSans, fontWordmark } from '@/lib/fonts';
import { NavBar } from '@/components/nav-bar';
import { Providers } from '@/components/providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'pix.fish',
  description: 'A personal image gallery with AI enrichment.',
  icons: { icon: '/favicon.ico' },
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
