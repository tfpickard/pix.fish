// Live-DOM helpers the fish brain uses to pick perches (sit on top of) and
// hideouts (slip behind). Both query the document on demand -- no
// MutationObserver, no caching -- because the calls are infrequent (a few
// times per minute at most) and the DOM keeps changing as the user navigates
// and scrolls.
//
// Selectors are an explicit allow-list. The fish is not supposed to perch on
// form inputs, modals, scroll containers, or anything where its presence
// could be mistaken for state. New opt-in surfaces can be marked with
// `data-fish-perch` / `data-fish-hide` attributes.

const PERCH_SELECTORS = ['header', 'article', '[data-fish-perch]'].join(',');
const HIDE_SELECTORS = ['article', '[data-fish-hide]'].join(',');

const MIN_WIDTH = 80;
const MIN_HEIGHT = 24;

interface PerchTarget {
  x: number;
  y: number;
}

// Sticky/fixed elements (the nav header is sticky at z-40) overlap site
// chrome the visitor needs to click. The fish would land *on top of* those
// controls and steal pointer events while perched, so exclude them from the
// perch set. Inline-positioned content-flow elements stay eligible.
function isStickyOrFixed(node: HTMLElement): boolean {
  const pos = getComputedStyle(node).position;
  return pos === 'sticky' || pos === 'fixed';
}

function visibleRectsIn(
  viewport: { w: number; h: number },
  selector: string,
  excludePinned: boolean
): DOMRect[] {
  const nodes = document.querySelectorAll<HTMLElement>(selector);
  const rects: DOMRect[] = [];
  for (const node of nodes) {
    if (excludePinned && isStickyOrFixed(node)) continue;
    const r = node.getBoundingClientRect();
    if (r.width < MIN_WIDTH || r.height < MIN_HEIGHT) continue;
    // Must overlap the viewport. Some breathing room (-32) lets the fish
    // approach perches that are *just* off-screen so it has somewhere to
    // head toward as the user scrolls.
    if (r.bottom < -32 || r.top > viewport.h + 32) continue;
    if (r.right < -32 || r.left > viewport.w + 32) continue;
    rects.push(r);
  }
  return rects;
}

// pickPerchTarget -- returns a point on the top edge of a random visible
// allow-listed element, with a small horizontal jitter so the fish doesn't
// always land on the same corner.
export function pickPerchTarget(): PerchTarget | null {
  const viewport = { w: window.innerWidth, h: window.innerHeight };
  const rects = visibleRectsIn(viewport, PERCH_SELECTORS, true);
  if (rects.length === 0) return null;
  const rect = rects[Math.floor(Math.random() * rects.length)];
  const minX = Math.max(rect.left + 16, 8);
  const maxX = Math.min(rect.right - 16, viewport.w - 8);
  if (maxX <= minX) return null;
  const x = minX + Math.random() * (maxX - minX);
  // The fish's sprite is 64x~38 px and the y we return is the fish's *top*
  // (translate origin), so subtract its half-height to seat it on the edge.
  const y = rect.top - 18;
  return { x, y };
}

// pickHideTarget -- returns a point inside an element's bounds, so the fish
// can swim toward "behind" it. Z-index management is the caller's job.
export function pickHideTarget(): PerchTarget | null {
  const viewport = { w: window.innerWidth, h: window.innerHeight };
  const rects = visibleRectsIn(viewport, HIDE_SELECTORS, false);
  if (rects.length === 0) return null;
  const rect = rects[Math.floor(Math.random() * rects.length)];
  const x = rect.left + 24 + Math.random() * Math.max(rect.width - 48, 0);
  const y = rect.top + 16 + Math.random() * Math.max(rect.height - 32, 0);
  return { x, y };
}
