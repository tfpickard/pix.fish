import type { Metadata } from 'next';
import { fontDisplay, fontMono, fontSans } from '@/lib/fonts';
import { NavBar } from '@/components/nav-bar';
import './globals.css';

export const metadata: Metadata = {
  title: 'pix.fish',
  description: 'A personal image gallery with AI enrichment.',
  icons: { icon: '/favicon.ico' }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${fontDisplay.variable} ${fontMono.variable} ${fontSans.variable}`}
    >
      <body className="min-h-screen font-sans antialiased">
        <NavBar />
        <main className="mx-auto w-full max-w-6xl px-4 pb-24">{children}</main>
      </body>
    </html>
  );
}
