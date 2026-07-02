// WA-COST — per-message pricing telemetry. Meta's per-message pricing model
// (July 2025+) attaches a pricing object to the sent-status webhook:
//   { billable, pricing_model, category, type }
// category: marketing / utility / authentication / service / referral_conversion
// type: regular / free_customer_service (utility inside the open 24h window) /
//       free_entry_point (the 72h CTWA free window).
// We persist those on whatsapp_messages (mig 341) and read Meta's own
// pricing_analytics for actual EUR cost (conversation_analytics is deprecated
// from Graph v25 — do not build on it).

/** Status webhook → whatsapp_messages pricing column patch, or null when absent. */
export function pricingColumnsFromStatus(status) {
  const p = status?.pricing
  if (!p || typeof p !== 'object') return null
  const patch = {}
  if (p.category) patch.pricing_category = p.category
  if (p.type) patch.pricing_type = p.type
  if (typeof p.billable === 'boolean') patch.billable = p.billable
  return Object.keys(patch).length ? patch : null
}

/** WABA-node pricing_analytics URL (COST + VOLUME, monthly by default). */
export function buildPricingAnalyticsUrl({ wabaId, start, end, granularity = 'MONTHLY' }) {
  const field = `pricing_analytics.start(${start}).end(${end}).granularity(${granularity}).metric_types([COST,VOLUME]).dimensions([PRICING_CATEGORY,PRICING_TYPE])`
  return `https://graph.facebook.com/v21.0/${wabaId}?fields=${encodeURIComponent(field)}`
}

/**
 * Fetch Meta's pricing analytics for a WABA. Returns the pricing_analytics
 * payload or null (missing config / API error) — callers treat it as optional
 * enrichment next to the local rollup. Never throws.
 */
export async function fetchPricingAnalytics({ wabaId, accessToken }, { start, end, granularity } = {}) {
  try {
    if (!wabaId || !accessToken || !start || !end) return null
    const res = await fetch(buildPricingAnalyticsUrl({ wabaId, start, end, granularity }), {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok || json.error) {
      console.error('[wa-pricing] pricing_analytics failed:', json.error?.message || `HTTP ${res.status}`)
      return null
    }
    return json.pricing_analytics || null
  } catch (e) {
    console.error('[wa-pricing] pricing_analytics error:', e?.message)
    return null
  }
}
