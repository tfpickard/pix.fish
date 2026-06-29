'use client';

// Client-only, code-split mount for the Pisci chat widget. The root layout is a
// server component, so the ssr:false dynamic import has to live behind this
// 'use client' boundary. Deferring it keeps the widget out of the initial bundle
// and off the SSR path -- it never regresses first paint.

import dynamic from 'next/dynamic';

const PisciChatWidget = dynamic(
  () => import('./pisci-chat-widget').then((m) => m.PisciChatWidget),
  { ssr: false }
);

export function PisciChatMount() {
  return <PisciChatWidget />;
}
