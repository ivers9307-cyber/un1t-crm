// SAAS4-M1 — the single Anthropic Messages API entry point.
//
// Every server-side Claude call goes through anthropicMessages() so
// token usage is metered per tenant (usage_events, mig 411) without
// each call site re-implementing capture. This wraps the repo's
// existing raw-fetch convention (no SDK dependency — deliberate; see
// CLAUDE.md: Mia stays on the Anthropic Messages API): same URL, same
// headers, same error semantics.
//
// Contract: returns { res, data }.
//   - res: the fetch Response, untouched — callers keep their existing
//     branching on res.ok / res.status / res.text().
//   - data: the parsed JSON body when res.ok (null if the body wasn't
//     JSON); always null when !res.ok (the error body is left on res
//     for the caller to read).
// Network errors propagate unchanged. Usage recording is fire-and-
// forget and can never break the reply path.

import { recordUsage } from './usage.js'

export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
export const ANTHROPIC_VERSION = '2023-06-01'

/**
 * @param {object} body - the Messages API request body (model, max_tokens, system, messages, tools, ...)
 * @param {{ apiKey?: string, locationId?: string|null, organizationId?: string|null,
 *           source: string, signal?: AbortSignal }} meta
 *   source: stable call-site key ('mia_auto_reply' | 'assistant_chat' | 'invoice_ocr'
 *   | 'followups' | 'approval_suggest' | 'hunt_scoring' | 'flow_agent' | 'hyrox_generation').
 */
export async function anthropicMessages(body, meta = {}) {
  const apiKey = meta.apiKey || process.env.ANTHROPIC_API_KEY
  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
    ...(meta.signal ? { signal: meta.signal } : {}),
  })

  if (!res.ok) return { res, data: null }

  // On OK the body is consumed here — callers read `data`, never the
  // body again. On !ok the body is untouched so callers keep their
  // existing res.text() error handling.
  const data = await res.json().catch(() => null)

  if (data?.usage) {
    try {
      // Not awaited on purpose — metering must never add latency or
      // failure modes to the reply path.
      Promise.resolve(
        recordUsage({
          locationId: meta.locationId ?? null,
          organizationId: meta.organizationId ?? null,
          source: meta.source,
          model: body?.model,
          usage: data.usage,
        })
      ).catch(() => {})
    } catch {
      /* metering must never break the call */
    }
  }

  return { res, data }
}
