# Build brief -- Substrate 1: the traffic ledger

**Status:** approved (owner green-lit; build first, before the Track A features that consume it).
**Depends on:** nothing. **Unblocks:** A3 erosion (node accumulator) and A4 desire paths (edge accumulator).
**Effort:** S. **Branch:** `feat/traffic-ledger` (one feature = one branch = one PR, per CONTRACTS.md).

## Objective

Extend the existing anonymous attention telemetry into a shared substrate that both attention-ecology
features read, so neither reinvents ingest, decay, or the consent posture:

1. a **monotonic lifetime accumulator per image** (permanent handling; does not decay) -- for erosion, and
2. a **per-edge traffic counter** (decaying, mirrors attention) recording which image-to-image edges
   visitors actually traverse -- for desire paths.

This brief builds only the substrate. It renders nothing and changes no visible behavior. A3 and A4
are separate briefs that consume it.

## Context (what already exists -- do not rebuild)

- `image_attention(image_id pk, value real default 0, last_updated_at)` -- `schema.ts:796`, created
  idempotently in `scripts/ensure-features.ts:71`.
- Decay math: `src/lib/attention.ts` -- `decayed(value, lastUpdatedAt, now, halfLifeMs)`,
  `normalizeAttention(map)`, `ATTENTION_HALF_LIFE_MS = 3 days`. Pure, dependency-free. **Reuse verbatim.**
- Atomic write: `bumpAttention(increments)` in `src/lib/db/queries/attention.ts` -- single upsert that
  decays-then-adds in SQL (`value * power(0.5, epoch_age / HALF_LIFE_SECONDS) + excluded.value`),
  lost-update-safe. Read: `getDecayedAttentionMap(ids)`.
- Ingest: `POST /api/attention` (`src/app/api/attention/route.ts`) -- consent-gated client
  (`attention-client.ts` only fires when NOT DNT and NOT opted-out), IP-hash rate-limited (never
  persisted), clamps samples, best-effort (never fails the visitor's request). **Mirror this posture exactly.**
- Walk sources that currently discard their traversal: `/connect` + `GET /api/path`
  (`src/app/api/path/route.ts`, returns `PathNode[]`), `/drift` + `POST /api/drift/next` (stateless per
  route.ts:18), `/daily`. `JourneyPlayer` (`src/components/journey-player.tsx`) is the natural
  completion point to emit a walk.

## Data model changes

Add to `schema.ts` and to `scripts/ensure-features.ts` (the established idempotent-DDL idiom; the human
runs `bun run db:generate` once at integration to emit the consolidated migration).

1. **New column on `image_attention`:**
   ```
   lifetime real NOT NULL DEFAULT 0   -- monotonic sum of dwell weight; never decays
   ```
   ensure-features: `ALTER TABLE "image_attention" ADD COLUMN IF NOT EXISTS "lifetime" real DEFAULT 0 NOT NULL`.

2. **New table `path_traffic`:**
   ```
   id             serial PK
   src_id         integer NOT NULL REFERENCES images(id) ON DELETE cascade
   dst_id         integer NOT NULL REFERENCES images(id) ON DELETE cascade
   value          real NOT NULL DEFAULT 0     -- decaying (mirrors image_attention.value)
   lifetime       real NOT NULL DEFAULT 0     -- monotonic traversal count
   last_updated_at timestamptz NOT NULL DEFAULT now()
   UNIQUE (src_id, dst_id)                    -- directed edge; a->b distinct from b->a
   INDEX on src_id
   ```

## New / modified code

**Modify `src/lib/db/queries/attention.ts` -- `bumpAttention`:** in the `onConflictDoUpdate.set`, add
`lifetime: sql`${imageAttention.lifetime} + excluded.value`` (raw add, NO decay factor). The insert
branch seeds `lifetime` = the increment (add `lifetime: r.increment` to the `.values(...)` map). One
statement still; lifetime rides alongside the existing decaying `value`. Add
`getLifetimeAttentionMap(ids)` returning raw `lifetime` (no decay) for erosion.

**New `src/lib/db/queries/path-traffic.ts`** (mirror attention.ts):
- `bumpPathTraffic(edges: {srcId, dstId, weight}[])` -- one upsert on `(src_id, dst_id)`; decaying
  `value` uses the identical SQL decay expression as `bumpAttention` (reuse `HALF_LIFE_SECONDS`), plus
  `lifetime = path_traffic.lifetime + excluded.value`.
- `getDecayedPathTrafficMap(edgeKeys)` / `getTopPaths(limit)` -- read decayed edge weights (apply
  `decayed()` in JS, same as `getDecayedAttentionMap`), keyed `"src:dst"`.

**New `POST /api/traffic`** (sibling of `/api/attention`, same file shape):
- Body: `{ walk: number[] }` (ordered image ids of a completed traversal) and/or
  `{ edges: {a,b}[] }`. Convert an ordered `walk` to consecutive directed edges `(walk[i], walk[i+1])`.
- Same IP-hash rate limit (`rateLimit(`traffic:${ipHash}`, ...)`), same MAX cap on edges/walk length,
  same best-effort `{ok:true}` swallow, same `runtime='nodejs'`.
- Fixed weight per traversal (e.g. `1.0` per edge; a walk contributes 1.0 to each of its edges). Do NOT
  weight by dwell here -- traversal is the signal, dwell is `image_attention`'s job.
- Aggregate per edge before the upsert (a walk that revisits an edge counts once per occurrence).

**New client emit** -- extend `attention-client.ts` or add `src/lib/traffic-client.ts` behind the SAME
consent gate (DNT + opt-out check; reuse `ATTENTION_OPTOUT_KEY` posture). Emit points:
- `/connect`: on a rendered found-path, POST `{ walk: path.map(n => n.imageId) }` once (guard against
  re-POST on back/refresh -- key by the a/b slugs).
- `/drift`: POST the trajectory's realized image ids when a session ends (the client already holds the
  trajectory).
- `/daily`: POST the guessed path on completion.
  (These three can land incrementally; `/connect` is the minimum to prove the substrate.)

## Precompute vs request-time

All request-time and free: ingest is a fire-and-forget upsert (like attention). No cron, no job. Decay
is read-time math. Erosion (A3) and desire-path promotion (A4) add their own nightly jobs in their own
briefs; this substrate adds none.

## Privacy

Identical to attention, non-negotiable: consent-gated client (DNT + explicit opt-out fully disable),
IP-hash for rate-limiting only and never persisted, no PII -- `path_traffic` stores only image-id pairs
and aggregate weights. A visitor who opted out contributes nothing (but may still *see* wear/paths,
which are aggregate). State this in the route's header comment as attention.ts does.

## Verification

- `bun run typecheck && bun run lint && bun run build`.
- Run `bun scripts/ensure-features.ts` twice -> idempotent, reports tables present, `lifetime` column
  added once.
- POST `/api/traffic` with a 3-node walk; assert two `path_traffic` rows with `value≈lifetime≈1.0`.
  POST the same walk again; assert `lifetime≈2.0` and `value` reflects one decay step + increment.
- Confirm `getLifetimeAttentionMap` returns un-decayed sums while `getDecayedAttentionMap` still decays.
- Confirm opt-out / DNT path sends nothing (network tab: no `/api/traffic` calls).

## Out of scope (belongs to A3 / A4)

No wear model, no wear overlay, no path promotion, no `desire_paths` table, no map/manifold edge
rendering. This brief ends when the accumulators exist and are being written.

## Open questions (resolved defaults; flag if you disagree)

- Edge granularity over whole-path identity: **accumulate per edge** (robust to Dijkstra returning
  slightly different node sequences). A4 designates routes as hot edge-chains.
- Weight `/connect` (deliberate) higher than `/drift`/`/daily` (incidental)? **Default: equal weight**;
  make the per-source weight a constant that A4 can tune later.
