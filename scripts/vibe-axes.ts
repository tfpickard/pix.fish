/**
 * Derive candidate "vibe axes" for the equalizer, three different ways, so the
 * owner can compare interpretability before committing one to the DB.
 *
 * Usage:
 *   POSTGRES_URL=... OPENAI_API_KEY=... bun scripts/vibe-axes.ts
 *     -> prints a JSON comparison of all three approaches to stdout
 *
 *   POSTGRES_URL=... bun scripts/vibe-axes.ts --write tag
 *   POSTGRES_URL=... bun scripts/vibe-axes.ts --write pca
 *   POSTGRES_URL=... OPENAI_API_KEY=... ANTHROPIC_API_KEY=... bun scripts/vibe-axes.ts --write kmeans
 *     -> replaces the vibe_axes table with the chosen approach's axes
 *
 * The three approaches:
 *   tag    -- hand-picked bipolar axes scored from the tag taxonomy. Fast,
 *             obviously interpretable, but can miss latent structure.
 *   pca    -- principal components of the caption embeddings (via the n x n
 *             Gram trick). Mathematically clean; components are not guaranteed
 *             to be human-interpretable.
 *   kmeans -- k clusters of the embeddings, each named by the LLM. Each cluster
 *             becomes a unipolar "how much like this vibe" axis.
 */
import { allCaptionVectors } from '../src/lib/db/queries/embeddings';
import { getImagesByIdsOrdered, hydrateImages } from '../src/lib/db/queries/images';
import type { ImageWithRelations } from '../src/lib/db/queries/images';
import { replaceVibeAxes } from '../src/lib/db/queries/vibe-axes';
import { getProvider, loadUserProviderKeys } from '../src/lib/ai';
import { loadAiConfig } from '../src/lib/ai/loadConfig';
import { getSiteAdminId } from '../src/lib/db/queries/users';
import { meanVector, subtractVector, cosineSim } from '../src/lib/ai/vector';

type Sample = { imageId: number; vec: number[]; caption: string; tags: string[] };

const EXAMPLES = 5;

function captionOf(img: ImageWithRelations): string {
  return img.captions.find((c) => c.isSlugSource)?.text ?? img.captions[0]?.text ?? img.slug;
}

async function loadCorpus(): Promise<Sample[]> {
  const vecs = await allCaptionVectors();
  if (vecs.length === 0) return [];
  const rows = await getImagesByIdsOrdered(vecs.map((v) => v.imageId));
  const hydrated = await hydrateImages(rows);
  const byId = new Map(hydrated.map((h) => [h.id, h]));
  return vecs
    .map((v) => {
      const img = byId.get(v.imageId);
      if (!img) return null;
      return {
        imageId: v.imageId,
        vec: v.vec,
        caption: captionOf(img),
        tags: img.tags.map((t) => t.tag)
      };
    })
    .filter((s): s is Sample => s !== null);
}

// ---------------------------------------------------------------------------
// Approach 1: hand-picked tag-cluster axes
// ---------------------------------------------------------------------------

type TagAxis = { key: string; label: string; neg: string[]; pos: string[]; negPole: string; posPole: string };

const TAG_AXES: TagAxis[] = [
  { key: 'absurdity', label: 'absurdity', negPole: 'documentary', posPole: 'surreal', neg: ['documentary', 'candid', 'still-life'], pos: ['surreal', 'whimsical', 'experimental', 'abstract'] },
  { key: 'dread', label: 'dread', negPole: 'serene', posPole: 'ominous', neg: ['calm', 'serene', 'tender', 'playful'], pos: ['eerie', 'ominous', 'tense', 'dark'] },
  { key: 'saturation', label: 'saturation', negPole: 'muted', posPole: 'vibrant', neg: ['muted', 'desaturated', 'monochrome', 'black-and-white'], pos: ['vibrant', 'saturated', 'neon'] },
  { key: 'warmth', label: 'warmth', negPole: 'cold', posPole: 'warm', neg: ['cold', 'blue-hour'], pos: ['golden-hour', 'nostalgic', 'tender'] },
  { key: 'wildness', label: 'nature vs built', negPole: 'urban', posPole: 'wild', neg: ['urban', 'architecture', 'signage', 'interior'], pos: ['nature', 'flora', 'forest', 'mountain', 'water'] },
  { key: 'stillness', label: 'stillness', negPole: 'chaotic', posPole: 'still', neg: ['chaotic'], pos: ['calm', 'serene', 'minimalist'] },
  { key: 'intimacy', label: 'intimacy', negPole: 'distant', posPole: 'intimate', neg: ['landscape', 'aerial', 'crowd'], pos: ['portrait', 'self-portrait', 'macro', 'tender'] },
  { key: 'brightness', label: 'brightness', negPole: 'dark', posPole: 'bright', neg: ['dark', 'night', 'low-contrast'], pos: ['bright', 'high-contrast', 'natural-light'] }
];

function tagApproach(corpus: Sample[]) {
  return TAG_AXES.map((axis) => {
    const scored = corpus.map((s) => {
      const tagSet = new Set(s.tags);
      const pos = axis.pos.filter((t) => tagSet.has(t)).length;
      const neg = axis.neg.filter((t) => tagSet.has(t)).length;
      return { caption: s.caption, score: pos - neg };
    });
    const posExamples = [...scored].sort((a, b) => b.score - a.score).filter((x) => x.score > 0).slice(0, EXAMPLES).map((x) => x.caption);
    const negExamples = [...scored].sort((a, b) => a.score - b.score).filter((x) => x.score < 0).slice(0, EXAMPLES).map((x) => x.caption);
    return {
      key: axis.key,
      label: axis.label,
      negativePole: axis.negPole,
      positivePole: axis.posPole,
      negExamples,
      posExamples
    };
  });
}

// ---------------------------------------------------------------------------
// Approach 2: PCA via the n x n Gram trick
// ---------------------------------------------------------------------------

function pcaApproach(corpus: Sample[], k = 8) {
  const n = corpus.length;
  if (n < 3) return [];
  const dim = corpus[0]!.vec.length;
  const mean = meanVector(corpus.map((s) => s.vec));
  const centered = corpus.map((s) => subtractVector(s.vec, mean));

  // Gram matrix G = Xc Xc^T (n x n). Its top eigenvectors u (n-dim) give the
  // per-sample projection scores directly: projecting sample i onto principal
  // direction v is proportional to u_i, so we never materialise the 1536-dim
  // eigenvectors.
  const G: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let dot = 0;
      for (let d = 0; d < dim; d++) dot += centered[i]![d]! * centered[j]![d]!;
      G[i]![j] = dot;
      G[j]![i] = dot;
    }
  }

  const axes: { scores: number[] }[] = [];
  const Gwork = G.map((r) => [...r]);
  for (let comp = 0; comp < Math.min(k, n - 1); comp++) {
    // Power iteration for the dominant eigenvector of Gwork.
    let u = new Array<number>(n).fill(0).map(() => Math.random() - 0.5);
    let lambda = 0;
    for (let iter = 0; iter < 100; iter++) {
      const next = new Array<number>(n).fill(0);
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let j = 0; j < n; j++) s += Gwork[i]![j]! * u[j]!;
        next[i] = s;
      }
      const norm = Math.sqrt(next.reduce((a, x) => a + x * x, 0)) || 1;
      for (let i = 0; i < n; i++) next[i] = next[i]! / norm;
      lambda = norm;
      u = next;
    }
    axes.push({ scores: u });
    // Deflate: Gwork -= lambda * u u^T.
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) Gwork[i]![j] = Gwork[i]![j]! - lambda * u[i]! * u[j]!;
    }
  }

  // Most common tag among a set of sample indices -- a cheap human label for a
  // PCA pole.
  function dominantTag(indices: number[]): string {
    const counts = new Map<string, number>();
    for (const i of indices) for (const t of corpus[i]!.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    let best = 'mixed';
    let bestN = 0;
    for (const [t, c] of counts) if (c > bestN) { bestN = c; best = t; }
    return best;
  }

  return axes.map((axis, idx) => {
    const order = axis.scores.map((s, i) => ({ s, i })).sort((a, b) => a.s - b.s);
    const negIdx = order.slice(0, EXAMPLES).map((x) => x.i);
    const posIdx = order.slice(-EXAMPLES).map((x) => x.i);
    return {
      key: `pc${idx + 1}`,
      label: `pc${idx + 1}`,
      negativePole: dominantTag(negIdx),
      positivePole: dominantTag(posIdx),
      negExamples: negIdx.map((i) => corpus[i]!.caption),
      posExamples: posIdx.reverse().map((i) => corpus[i]!.caption)
    };
  });
}

// ---------------------------------------------------------------------------
// Approach 3: k-means + LLM naming
// ---------------------------------------------------------------------------

function normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

async function kmeansApproach(corpus: Sample[], k = 8) {
  const n = corpus.length;
  if (n < k) return [];
  const unit = corpus.map((s) => normalize(s.vec));
  // Init centroids from the first k (deterministic enough for a dev script).
  let centroids = unit.slice(0, k).map((v) => [...v]);
  let assign = new Array<number>(n).fill(0);
  for (let iter = 0; iter < 25; iter++) {
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestSim = -Infinity;
      for (let c = 0; c < k; c++) {
        const sim = cosineSim(unit[i]!, centroids[c]!);
        if (sim > bestSim) { bestSim = sim; best = c; }
      }
      assign[i] = best;
    }
    const sums = Array.from({ length: k }, () => new Array<number>(unit[0]!.length).fill(0));
    const counts = new Array<number>(k).fill(0);
    for (let i = 0; i < n; i++) {
      counts[assign[i]!]++;
      const row = sums[assign[i]!]!;
      for (let d = 0; d < row.length; d++) row[d] += unit[i]![d]!;
    }
    centroids = sums.map((row, c) => (counts[c]! > 0 ? normalize(row.map((x) => x / counts[c]!)) : centroids[c]!));
  }

  const clusters = Array.from({ length: k }, (_, c) => {
    const members = corpus.filter((_, i) => assign[i] === c);
    return { index: c, captions: members.map((m) => m.caption) };
  }).filter((cl) => cl.captions.length > 0);

  // Name each cluster with the LLM if a provider is configured. Inline prompt
  // (a one-off analysis script, not a product prompt) -- kept out of the
  // prompts table on purpose.
  const cfg = await loadAiConfig();
  const keys = await loadUserProviderKeys(getSiteAdminId());
  const provider = getProvider('descriptions', cfg, keys);
  const named: { key: string; label: string; negativePole: string; positivePole: string; posExamples: string[] }[] = [];
  for (const cl of clusters) {
    let label = `cluster ${cl.index + 1}`;
    if (provider?.text) {
      try {
        const raw = await provider.text(
          `Here are captions from one cluster of a personal image gallery. Give a 1 to 3 word lower-case label naming the shared vibe. Reply with ONLY the label.\n\n${cl.captions.slice(0, 12).join('\n')}`
        );
        const cleaned = raw.trim().split('\n')[0]!.replace(/[".]/g, '').slice(0, 40);
        if (cleaned) label = cleaned;
      } catch (err) {
        console.error('cluster naming failed', err);
      }
    }
    named.push({
      key: label.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `cluster-${cl.index + 1}`,
      label,
      negativePole: `not ${label}`,
      positivePole: label,
      posExamples: cl.captions.slice(0, EXAMPLES)
    });
  }
  return named;
}

async function main() {
  if (!process.env.POSTGRES_URL) {
    console.error('POSTGRES_URL not set. Aborting.');
    process.exit(1);
  }
  const corpus = await loadCorpus();
  if (corpus.length === 0) {
    console.error('No caption embeddings found. Run the gallery enrichment / backfill first.');
    process.exit(1);
  }
  console.error(`Loaded ${corpus.length} embedded images.`);

  const writeIdx = process.argv.indexOf('--write');
  const approach = writeIdx >= 0 ? process.argv[writeIdx + 1] : null;

  if (!approach) {
    // Comparison mode: print all three to stdout for the owner to eyeball.
    const tag = tagApproach(corpus);
    const pca = pcaApproach(corpus);
    const kmeans = await kmeansApproach(corpus);
    process.stdout.write(JSON.stringify({ corpusSize: corpus.length, tag, pca, kmeans }, null, 2) + '\n');
    return;
  }

  let rows: { key: string; label: string; description: string | null; negativePole: string; positivePole: string; ordering: number }[] = [];
  if (approach === 'tag') {
    rows = tagApproach(corpus).map((a, i) => ({ key: a.key, label: a.label, description: null, negativePole: a.negativePole, positivePole: a.positivePole, ordering: i }));
  } else if (approach === 'pca') {
    rows = pcaApproach(corpus).map((a, i) => ({ key: a.key, label: a.label, description: 'principal component', negativePole: a.negativePole, positivePole: a.positivePole, ordering: i }));
  } else if (approach === 'kmeans') {
    rows = (await kmeansApproach(corpus)).map((a, i) => ({ key: a.key, label: a.label, description: 'embedding cluster', negativePole: a.negativePole, positivePole: a.positivePole, ordering: i }));
  } else {
    console.error(`Unknown approach "${approach}". Use one of: tag, pca, kmeans.`);
    process.exit(1);
  }

  await replaceVibeAxes(rows);
  console.error(`Wrote ${rows.length} vibe axes from approach "${approach}".`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
