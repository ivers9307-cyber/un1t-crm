// SAAS4-M1 — per-tenant usage metering (design: SaaS machinery plan §3).
//
// usage_events (mig 411) is the ledger for consumption that has NO
// existing per-send table — today that's Anthropic tokens. Email, SMS
// and WhatsApp volumes are derived from their existing location-tagged
// tables (email_sends / activities / whatsapp_messages) by the rollup
// cron instead of double-writing here.
//
// recordUsage is a fire-and-forget side effect per repo convention: it
// swallows every error (a metering failure must never break a customer
// reply or an OCR run) and callers do not await-and-branch on it.

import { createServerClient } from '@/lib/supabase'

// Cents per 1M tokens, keyed by model-family substring. An ESTIMATE for
// operator visibility and caps — Anthropic's invoice is the billing
// truth. Cache multipliers per the API pricing model: reads 0.1x input,
// writes 1.25x input (5-min TTL).
const FAMILY_PRICES_CENTS_PER_MTOK = [
  { match: 'opus', input: 500, output: 2500 },
  { match: 'haiku', input: 100, output: 500 },
  { match: 'sonnet', input: 300, output: 1500 },
]
const DEFAULT_PRICE = FAMILY_PRICES_CENTS_PER_MTOK[2] // sonnet — every current call site

export function estimateAnthropicCostCents(model, usage) {
  if (!usage) return 0
  const family =
    FAMILY_PRICES_CENTS_PER_MTOK.find((f) => String(model || '').includes(f.match)) || DEFAULT_PRICE
  const M = 1_000_000
  const input = (usage.input_tokens || 0) / M
  const output = (usage.output_tokens || 0) / M
  const cacheRead = (usage.cache_read_input_tokens || 0) / M
  const cacheWrite = (usage.cache_creation_input_tokens || 0) / M
  return (
    input * family.input +
    output * family.output +
    cacheRead * family.input * 0.1 +
    cacheWrite * family.input * 1.25
  )
}

/**
 * Append one usage event. Never throws; never blocks the caller's
 * primary work (callers fire it without awaiting on hot paths).
 *
 * @param {{ locationId?: string|null, organizationId?: string|null,
 *           source: string, model: string,
 *           usage: { input_tokens?: number, output_tokens?: number,
 *                    cache_read_input_tokens?: number,
 *                    cache_creation_input_tokens?: number } | null }} evt
 * @param {{ db?: object }} [deps] - injectable for tests; defaults to the service-role client
 */
export async function recordUsage(evt, { db } = {}) {
  try {
    if (!evt?.usage) return
    const client = db || createServerClient()
    const { error } = await client.from('usage_events').insert({
      organization_id: evt.organizationId ?? null,
      location_id: evt.locationId ?? null,
      meter: 'anthropic_tokens',
      source: evt.source,
      quantity: (evt.usage.input_tokens || 0) + (evt.usage.output_tokens || 0),
      cost_estimate_cents: estimateAnthropicCostCents(evt.model, evt.usage),
      meta: {
        model: evt.model,
        input_tokens: evt.usage.input_tokens || 0,
        output_tokens: evt.usage.output_tokens || 0,
        cache_read_input_tokens: evt.usage.cache_read_input_tokens || 0,
        cache_creation_input_tokens: evt.usage.cache_creation_input_tokens || 0,
      },
    })
    if (error && process.env.NODE_ENV !== 'production') {
      console.error('[usage] insert failed:', error.message)
    }
  } catch (e) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('[usage] recordUsage swallowed:', e?.message || e)
    }
  }
}
