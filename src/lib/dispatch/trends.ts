import { MAX_HEADLINES_PER_TREND, MAX_TREND_CANDIDATES, TREND_FETCH_TIMEOUT_MS } from './config';
import type { Trend } from './types';

// Trend acquisition. The posting target is X, but the trend source does not have
// to be: X's own trends endpoint is pay-per-use ($0.010/request, no free tier as
// of Feb 2026) and returns a bare topic with no context, which is useless to a
// safety gate that has to know what a topic is ABOUT before it can clear it.
//
// Google Trends' public RSS feed is free, needs no credentials, and carries two
// to five news headlines per topic -- exactly the context the classifier needs.
// That the trends come from Google searches and the hashtags land on X is, if
// anything, on-theme: the institution observed that these terms were popular
// somewhere and concluded they were required.
//
// Everything goes through the TrendSource shape so another source (Bluesky's
// public getTrendingTopics, X's paid endpoint) can be dropped in later without
// touching the safety gate or the handler.

export type TrendSource = {
  name: string;
  fetchTrends: () => Promise<Trend[]>;
};

const GOOGLE_TRENDS_RSS = 'https://trends.google.com/trending/rss';

// Minimal tag extraction. The feed is a small, stable, well-formed document and
// we need four fields from it; pulling in an XML parser for that would be a new
// dependency for no gain. Returns [] on anything unexpected -- a malformed feed
// is a skipped day, not a crash.
function extractAll(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]!);
  return out;
}

function extractFirst(xml: string, tag: string): string | null {
  return extractAll(xml, tag)[0] ?? null;
}

// Unwrap CDATA and decode the handful of entities RSS actually emits.
function decode(raw: string | null): string {
  if (!raw) return '';
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// Exported for the test suite: parsing is the part most likely to rot when the
// feed shape changes, and it is pure.
export function parseGoogleTrendsRss(xml: string): Trend[] {
  const trends: Trend[] = [];
  for (const item of extractAll(xml, 'item')) {
    const topic = decode(extractFirst(item, 'title'));
    if (!topic) continue;
    const headlines = extractAll(item, 'ht:news_item')
      .map((n) => ({
        title: decode(extractFirst(n, 'ht:news_item_title')),
        source: decode(extractFirst(n, 'ht:news_item_source')) || null
      }))
      .filter((h) => h.title.length > 0)
      .slice(0, MAX_HEADLINES_PER_TREND);
    trends.push({
      topic,
      source: 'google-trends',
      headlines,
      approxTraffic: decode(extractFirst(item, 'ht:approx_traffic')) || null
    });
    if (trends.length >= MAX_TREND_CANDIDATES) break;
  }
  return trends;
}

export function googleTrendsSource(geo = 'US'): TrendSource {
  return {
    name: 'google-trends',
    async fetchTrends() {
      // One attempt, hard deadline, no retry. A failed fetch is a skipped day.
      const res = await fetch(`${GOOGLE_TRENDS_RSS}?geo=${encodeURIComponent(geo)}`, {
        signal: AbortSignal.timeout(TREND_FETCH_TIMEOUT_MS),
        headers: { accept: 'application/rss+xml, application/xml, text/xml' },
        cache: 'no-store'
      });
      if (!res.ok) throw new Error(`google trends rss returned ${res.status}`);
      return parseGoogleTrendsRss(await res.text());
    }
  };
}

// The text the trend is embedded as, and the context block the classifier and
// the caption prompt both read. Topic first so it dominates the embedding.
export function trendText(t: Trend): string {
  return [t.topic, ...t.headlines.map((h) => h.title)].join('. ');
}

// Both prompts that read trend context quarantine it between markers and tell the
// model it is data. That only holds if the markers cannot be forged from inside
// the block -- and every field here is third-party text. Topics and headlines are
// whatever Google's feed carries, which is whatever a publisher chose to title an
// article; anyone who can get a headline indexed can put text of their choosing in
// front of the safety classifier, which is the one call whose job is to say no.
//
// So: strip every marker token this codebase uses (a trend field must not be able
// to forge the intake block either, since both appear in the caption prompt), then
// bound the length. Exported so the test suite can assert a forged marker in a
// headline does not survive into a prompt.
export function sanitizeTrendField(raw: string): string {
  return raw
    .replace(/<<<\s*(TRENDS|INTAKE)/gi, '(quoted)')
    .replace(/(TRENDS|INTAKE)\s*>>>/gi, '(quoted)')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export function formatTrendContext(t: Trend): string {
  const lines = [`Term: ${sanitizeTrendField(t.topic)}`];
  if (t.approxTraffic) {
    lines.push(`Reported search volume: ${sanitizeTrendField(t.approxTraffic)}`);
  }
  if (t.headlines.length === 0) {
    lines.push('Surrounding coverage: (none reported)');
  } else {
    lines.push('Surrounding coverage:');
    for (const h of t.headlines) {
      const source = h.source ? ` (${sanitizeTrendField(h.source)})` : '';
      lines.push(`- ${sanitizeTrendField(h.title)}${source}`);
    }
  }
  return lines.join('\n');
}

// Hashtag form of a topic: strip everything X will not carry, TitleCase the
// words, cap the length. "jaguar rebrand" -> "#JaguarRebrand".
export function hashtagFor(topic: string): string {
  const words = topic
    // Apostrophes are elided, not split on: "Jaguar's rebrand" must become
    // JaguarsRebrand, not JaguarSRebrand.
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '';
  const joined = words
    .map((w) => (w.toUpperCase() === w ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join('');
  // A hashtag cannot start with a digit on X; prefix nothing, just drop the tag
  // rather than post a broken one.
  if (/^\p{N}/u.test(joined)) return '';
  return `#${joined.slice(0, 60)}`;
}
