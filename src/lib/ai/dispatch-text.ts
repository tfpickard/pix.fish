import Anthropic from '@anthropic-ai/sdk';
import { loadAiConfig } from './loadConfig';
import { loadUserProviderKeys } from './keys';
import { getSiteAdminId } from '@/lib/db/queries/users';

// The bounded text call behind the X dispatch pipeline (safety classification
// and caption generation). It lives in src/lib/ai/ because that is the only
// place allowed to touch a provider SDK directly, and it exists separately from
// AIProvider.text() because that path hardcodes a 4096-token ceiling and the
// SDK's default two retries. Neither is acceptable on an unattended daily job:
// the brief's cost guards require a tight max_tokens and NO retry loop.
//
// Same posture as src/lib/ai/pisci-chat.ts -- a deliberately cheap, deliberately
// capped, deliberately Haiku-class call.

// Model routing comes from the 'dispatch' ai_config field (Haiku by default, see
// src/lib/ai/config.ts) so it is repointable from /admin/ai without a redeploy.
// Provider routing does not: this helper speaks Anthropic only. A 'dispatch' row
// naming another provider makes the call return null, which every caller treats
// as "skip the day" -- fail closed rather than silently running unbounded.
export type DispatchTextResult = { text: string; model: string; stopReason: string | null };

export async function dispatchText(opts: {
  prompt: string;
  maxTokens: number;
  timeoutMs: number;
}): Promise<DispatchTextResult | null> {
  const cfg = await loadAiConfig();
  const row = cfg.dispatch;
  if (row.provider !== 'anthropic') return null;

  const keys = await loadUserProviderKeys(getSiteAdminId());
  const apiKey = keys.anthropic;
  if (!apiKey) return null;

  // maxRetries: 0 is load-bearing, not a tuning choice. The SDK retries twice by
  // default; on a job that must "fail closed and log" a retry storm is the exact
  // failure mode the guards exist to prevent.
  const client = new Anthropic({ apiKey, maxRetries: 0 });
  const res = await client.messages.create(
    {
      model: row.model,
      max_tokens: opts.maxTokens,
      messages: [{ role: 'user', content: [{ type: 'text', text: opts.prompt }] }]
    },
    { timeout: opts.timeoutMs, maxRetries: 0 }
  );

  const block = res.content.find((c) => c.type === 'text');
  if (!block || block.type !== 'text') {
    // Name the cause instead of the symptom. "no text block" is true and
    // useless: it is equally consistent with a max_tokens cut before any text
    // was emitted, a refusal, or a model whose response is entirely non-text
    // blocks -- three problems with three different fixes, and the event log is
    // the only place an operator sees any of it. Report the stop reason and the
    // block types actually returned.
    const kinds = res.content.map((c) => c.type).join(', ') || 'none';
    throw new Error(
      `dispatch call returned no text block (model ${row.model}, stop_reason ${
        res.stop_reason ?? 'unknown'
      }, blocks: ${kinds}, max_tokens ${opts.maxTokens})`
    );
  }
  return { text: block.text, model: row.model, stopReason: res.stop_reason ?? null };
}
