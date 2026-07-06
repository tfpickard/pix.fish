/**
 * Score the current character census against the admin-labelled ground truth
 * (character_labels). Turns the checkmark/X grading workflow into precision /
 * recall / F1 so classification tuning is measured, not vibes.
 *
 *   bun run characters:eval
 *
 * Each labelled subject is matched to the census character with the greatest
 * image overlap; then, over LABELLED images only (unlabelled images are ignored,
 * so partial labelling still works):
 *   precision = TP / (TP + FP)   FP = predicted images marked wrong for the subject
 *   recall    = TP / |positives| TP = predicted images marked correct
 * A subject with no overlapping character scores 0 (a miss).
 */
import { listCharacters, listAppearances } from '../src/lib/db/queries/characters';
import { truthClusters } from '../src/lib/db/queries/character-labels';

function f1(p: number, r: number): number {
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

async function main() {
  const truth = await truthClusters();
  if (truth.size === 0) {
    console.error('no labels on file -- label appearances on /characters/<key> (admin) first.');
    process.exit(1);
  }

  // Current census: each character -> its set of appearance image ids.
  const chars = await listCharacters();
  const predicted = new Map<string, Set<number>>();
  for (const c of chars) {
    const app = await listAppearances(c.key);
    predicted.set(c.key, new Set(app.map((a) => a.imageId)));
  }

  const rows: { subject: string; match: string; tp: number; fp: number; p: number; r: number; f1: number }[] = [];
  for (const [subject, { positives, negatives }] of truth) {
    // Best-overlap census character for this subject.
    let bestKey = '';
    let bestOverlap = -1;
    let bestSet = new Set<number>();
    for (const [key, set] of predicted) {
      let overlap = 0;
      for (const id of positives) if (set.has(id)) overlap++;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestKey = key;
        bestSet = set;
      }
    }

    let tp = 0;
    let fp = 0;
    for (const id of bestSet) {
      if (positives.has(id)) tp++;
      else if (negatives.has(id)) fp++; // predicted but explicitly marked wrong
      // unlabelled predicted images are ignored (unknown ground truth)
    }
    const p = tp + fp === 0 ? 0 : tp / (tp + fp);
    const r = positives.size === 0 ? 0 : tp / positives.size;
    rows.push({ subject, match: bestKey || '(none)', tp, fp, p, r, f1: f1(p, r) });
  }

  const pad = (s: string, n: number) => s.padEnd(n);
  const pct = (x: number) => (x * 100).toFixed(0) + '%';
  console.log(`\ncharacter classification eval (${rows.length} labelled subject(s))\n`);
  console.log(pad('subject', 24), pad('match', 14), pad('TP', 4), pad('FP', 4), pad('prec', 6), pad('recall', 7), 'F1');
  console.log('-'.repeat(72));
  for (const r of rows.sort((a, b) => a.f1 - b.f1)) {
    console.log(
      pad(r.subject.slice(0, 23), 24),
      pad(r.match.slice(0, 13), 14),
      pad(String(r.tp), 4),
      pad(String(r.fp), 4),
      pad(pct(r.p), 6),
      pad(pct(r.r), 7),
      pct(r.f1)
    );
  }
  const n = rows.length;
  const avg = (sel: (x: (typeof rows)[number]) => number) => rows.reduce((s, x) => s + sel(x), 0) / n;
  console.log('-'.repeat(72));
  console.log(
    pad('MACRO AVG', 24),
    pad('', 14),
    pad('', 4),
    pad('', 4),
    pad(pct(avg((x) => x.p)), 6),
    pad(pct(avg((x) => x.r)), 7),
    pct(avg((x) => x.f1))
  );
  console.log('');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .then(() => process.exit(0));
