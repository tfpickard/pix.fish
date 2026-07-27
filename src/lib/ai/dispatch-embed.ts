import OpenAI from 'openai';
import type { AiConfigMap } from './types';
import type { UserProviderKeys } from './keys';

// The bounded embedding call behind the X dispatch, and the sibling of
// dispatch-text.ts. It exists for the same reason: the shared provider path is
// built for interactive and queued work where a retry is a kindness, and this job
// is neither.
//
// getEmbedder() hands back src/lib/ai/openai.ts's embed(), whose client is
// constructed without maxRetries, so the SDK retries a 429 or 5xx twice by
// default. The handler races that call against a deadline, but a race does not
// cancel anything: on a slow failure the dispatch files its skip and the retries
// carry on underneath, spending tokens and time after the job has given up. That
// is precisely the retry loop the brief's cost guards forbid.
//
// So: maxRetries 0 at both the client and the request, plus a real AbortSignal so
// the deadline cancels the work instead of merely stopping the waiting.

// text-embedding-3-small is fixed at 1536 dims, matching embeddings.vec in
// schema.ts. Routing to a different width means a schema change, so assert it.
const EMBED_DIMENSIONS = 1536;

export type DispatchEmbedder = {
  // Provenance, written the same way the enrichment path writes it, so the
  // candidate query can filter to vectors from this exact embedding space.
  name: string;
  model: string;
  embed: (input: string, timeoutMs: number) => Promise<number[]>;
};

// Returns null rather than throwing when embeddings are routed somewhere this
// helper cannot speak. Callers treat null as "skip the day" -- fail closed. That
// also covers the case where ai_config points embeddings at Anthropic, which the
// admin UI permits and which has no embed() at all: previously that threw from
// inside the handler after the day was already claimed.
export function getDispatchEmbedder(
  cfg: AiConfigMap,
  keys: UserProviderKeys
): DispatchEmbedder | null {
  const row = cfg.embeddings;
  if (row.provider !== 'openai') return null;
  const apiKey = keys.openai;
  if (!apiKey) return null;

  const client = new OpenAI({ apiKey, maxRetries: 0 });
  return {
    name: 'openai',
    model: row.model,
    async embed(input: string, timeoutMs: number): Promise<number[]> {
      const res = await client.embeddings.create(
        { model: row.model, input, dimensions: EMBED_DIMENSIONS },
        { timeout: timeoutMs, maxRetries: 0, signal: AbortSignal.timeout(timeoutMs) }
      );
      const vec = res.data[0]?.embedding;
      if (!vec) throw new Error('dispatch embedding response had no vector');
      if (vec.length !== EMBED_DIMENSIONS) {
        throw new Error(
          `dispatch embedding returned ${vec.length} dims; expected ${EMBED_DIMENSIONS} for ${row.model}`
        );
      }
      if (!vec.every((n) => Number.isFinite(n))) {
        throw new Error('dispatch embedding response contained non-finite numbers');
      }
      return vec;
    }
  };
}
