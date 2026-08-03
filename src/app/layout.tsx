import type { Metadata, Viewport } from 'next';
import { BotIdClient } from 'botid/client';
import { Analytics } from '@vercel/analytics/next';
import { fontDisplay, fontMono, fontSans, fontWordmark } from '@/lib/fonts';
import { NavBar } from '@/components/nav-bar';
import { Providers } from '@/components/providers';
import { SiteFooter } from '@/components/site-footer';
import { JsonLd } from '@/components/json-ld';
import { TemperatureHud } from '@/components/temperature-hud';
import { PixFish } from '@/components/pix-fish/pix-fish';
import { PisciChatMount } from '@/components/pisci-chat-mount';
import { BOTID_PROTECTED_ROUTES } from '@/lib/botid-routes';
import { SITE_NAME, SITE_URL, DEFAULT_DESCRIPTION } from '@/lib/site';
import { buildWebSiteLd } from '@/lib/seo/jsonld';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  // The `%s -- pix.fish` template applies to all nested pages that set a title;
  // the home page opts out by exporting `title: { absolute: 'pix.fish' }` so it
  // doesn't render as "pix.fish -- pix.fish".
  title: {
    default: SITE_NAME,
    template: '%s -- ' + SITE_NAME
  },
  description: DEFAULT_DESCRIPTION,
  applicationName: SITE_NAME,
  alternates: {
    canonical: '/'
  },
  openGraph: {
    type: 'website',
    url: SITE_URL,
    siteName: SITE_NAME,
    title: SITE_NAME,
    description: DEFAULT_DESCRIPTION,
    // Static branded fallback. A per-route `opengraph-image` export (when any
    // route defines one) overrides this automatically; otherwise share cards
    // render the wordmark instead of the default favicon.
    images: [{ url: '/logo-magenta.png', width: 1024, height: 1024, alt: SITE_NAME }]
  },
  twitter: {
    card: 'summary_large_image',
    title: SITE_NAME,
    description: DEFAULT_DESCRIPTION,
    images: ['/logo-magenta.png']
  },
  robots: {
    index: true,
    follow: true,
    // `max-image-preview: large` is the single most important directive for
    // an image gallery: it tells Google it's allowed to show the images at
    // large size in results rather than tiny thumbnails.
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1
    }
  },
  verification: {
    google: process.env.GOOGLE_SITE_VERIFICATION || undefined,
    other: process.env.BING_SITE_VERIFICATION
      ? { 'msvalidate.01': process.env.BING_SITE_VERIFICATION }
      : undefined
  },
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
      <head>
        {/* Next 14 predates the instrumentation-client.ts hook BotID uses from
            15.3 on, so the client half is mounted here instead. It must be in
            <head> and ahead of any protected fetch: it instruments window.fetch
            to attach a token, and a request that fires before it loads arrives
            unsigned and reads as a bot. */}
        <BotIdClient protect={[...BOTID_PROTECTED_ROUTES]} />
      </head>
      <body className="min-h-screen font-sans antialiased">
        <Providers>
          <NavBar />
          {/* feat: Pisci anti-service chat widget. Client-only and code-split
              (ssr:false) so it never touches SSR or initial paint. Mounted
              between the nav and <main> on purpose: its open state is an
              in-flow sticky banner, so sitting here reserves real space and
              pushes the page body below it (the fixed corner popup used to
              cover the header). Its closed launcher is fixed, so it costs no
              flow space when hidden. */}
          <PisciChatMount />
          <main className="mx-auto w-full max-w-6xl px-4 pb-12">{children}</main>
          <SiteFooter />
        </Providers>
        {/* feat/hud: fixed-position, dismissible overlay. Outside <main> and
            <Providers> so it never affects document flow (zero layout shift).
            Renders nothing until an entropy.recompute has recorded a reading. */}
        <TemperatureHud />
        {/* feat/pix-fish: ambient mascot. Client-only; lives outside <main>
            and <Providers> so it never participates in document flow and
            survives every route change (root layout doesn't remount). */}
        <PixFish />
        <JsonLd data={buildWebSiteLd()} />
        <Analytics />
      </body>
    </html>
  );
}
