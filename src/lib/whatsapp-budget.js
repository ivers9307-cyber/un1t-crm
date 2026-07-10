// WA-BUDGET — per-number daily send budget enforced against Meta's messaging-
// limit tier (comms audit 2026-07-10). Meta caps BUSINESS-INITIATED
// conversations per number in a ROLLING 24h window (whatsapp_numbers.
// messaging_limit_tier: TIER_250 = 250 unique users/24h, … see TIER_DAILY_LIMITS).
// The tier was stored (mig 329, refreshed by webhook + poll) but unenforced —
// concurrent drips plus a blast could blow the tier, and over-tier sends both
// hard-fail at Meta AND burn the number's quality rating.
//
// USAGE APPROXIMATION (documented on purpose): we count DISTINCT contacts who
// received a TEMPLATE message (whatsapp_messages: direction='outbound',
// message_type='template') at the location in the trailing 24h. Template sends
// are how this app initiates conversations, so distinct template recipients ≈
// business-initiated conversations. Known deltas, both conservative:
//   • a template sent inside an already-open customer-service window doesn't
//     consume Meta budget but we count it → we under-spend, never over-spend;
//   • whatsapp_messages carries no sender-number id, so usage is counted per
//     LOCATION — a multi-number location debits every number's tier with the
//     location's whole spend (single-number locations, i.e. all of them today,
//     are exact).
// Free-form sends (Mia replies, inbox 1:1 text) ride user-initiated windows,
// are message_type != 'template', and correctly never count.
//
// ENFORCEMENT policy: only the two BULK paths are gated —
//   (a) blast preflight: sendBroadcast refuses to START a blast whose pending
//       audience exceeds the remaining headroom (WA-BUDGET.1). `force:true`
//       does NOT bypass this gate — Meta hard-rejects over-tier sends anyway,
//       so forcing would just drain the audience into failures;
//   (b) drip tick sizing: sendDripChunk caps each tick to the remaining global
//       headroom (WA-BUDGET.2) — the per-broadcast rolling-24h daily_cap
//       already existed; this is the cross-sender layer on top of it.
// Low-volume template paths (sequence steps, radar outreach, automations,
// inbox template sends) COUNT toward usage but are NOT gated: they are
// conversation-level and low-volume, and blocking a booking confirmation to
// protect a marketing budget would be backwards. Null/unknown/UNLIMITED tier
// (or an env-fallback config with no location) = no gate.

import { tierLabel } from './whatsapp-number-health'

// Meta messaging-limit tier → business-initiated conversations per rolling 24h.
// UNLIMITED (and unknown/null) carry no numeric limit → ungated.
export const TIER_DAILY_LIMITS = Object.freeze({
  TIER_50: 50, TIER_250: 250, TIER_1K: 1000, TIER_10K: 10000, TIER_100K: 100000,
})

// Daily unique-contact limit for a tier, or null when the tier is ungated.
export function tierDailyLimit(tier) {
  return TIER_DAILY_LIMITS[tier] ?? null
}

// { tier, limit, used, remaining } for a gated tier, or null when ungated.
export function budgetSnapshot({ tier, usedContacts } = {}) {
  const limit = tierDailyLimit(tier)
  if (limit == null) return null
  const used = Math.max(0, usedContacts || 0)
  return { tier, limit, used, remaining: Math.max(0, limit - used) }
}

// WA-BUDGET.1 — blast preflight refusal, or null to proceed. Deliberately NOT
// force-bypassable (unlike the quality gate): the tier is Meta's hard limit,
// not our policy. Pure — unit-tested in whatsapp-budget.test.js.
export function blastBudgetBlockError(budget, pendingCount) {
  if (!budget || pendingCount <= budget.remaining) return null
  return `This blast would start ${pendingCount} business-initiated conversations but the number only has ` +
    `${budget.remaining} left of its ${tierLabel(budget.tier)} Meta messaging limit ` +
    `(${budget.used}/${budget.limit} used in the rolling 24h window). Capacity frees up as earlier sends age ` +
    `past 24 hours — wait, shrink the audience, or send it as a drip. ` +
    `This limit is enforced by Meta (over-tier sends hard-reject), so it cannot be forced.`
}

// WA-BUDGET.2 — a drip tick's send ceiling once the global tier budget is
// layered on the per-broadcast headroom. No budget (ungated) → cap unchanged.
export function effectiveTickHeadroom(capHeadroom, budget) {
  if (!budget) return capHeadroom
  return Math.min(capHeadroom, budget.remaining)
}

/**
 * DISTINCT contacts who received a template (business-initiated) message at
 * this location in the trailing 24h — the shared usage counter every sender
 * (blast, drip, sequence, automation, inbox template) contributes to via its
 * whatsapp_messages insert. Rows with no linked contact each count once
 * (conservative: can only over-count usage, never free up phantom headroom).
 * Paginated (>1k-safe) with a deterministic order, per the PostgREST cap rule.
 */
export async function countBusinessInitiatedContactsLast24h(db, locationId) {
  const PAGE = 1000
  const HARD_LIMIT = 200_000
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const seen = new Set()
  let unlinked = 0
  let start = 0
  while (true) {
    const end = Math.min(start + PAGE - 1, HARD_LIMIT - 1)
    const { data: page, error } = await db.from('whatsapp_messages')
      .select('id, contact_id')
      .eq('location_id', locationId)
      .eq('direction', 'outbound')
      .eq('message_type', 'template')
      .gt('sent_at', since)
      .order('id', { ascending: true })
      .range(start, end)
    if (error) throw new Error(`WhatsApp budget usage query failed: ${error.message}`)
    if (!Array.isArray(page) || page.length === 0) break
    for (const r of page) {
      if (r.contact_id) seen.add(r.contact_id)
      else unlinked++
    }
    if (page.length < PAGE) break
    if (start + PAGE >= HARD_LIMIT) break
    start += PAGE
  }
  return seen.size + unlinked
}

/**
 * The location's current send budget against `tier`, or null when there is no
 * gate (UNLIMITED / unknown tier, or an env-fallback config with no location —
 * matching the quality gate's "env configs carry no rating" posture).
 */
export async function getSendBudget(db, { locationId, tier } = {}) {
  if (!locationId || tierDailyLimit(tier) == null) return null
  const used = await countBusinessInitiatedContactsLast24h(db, locationId)
  return budgetSnapshot({ tier, usedContacts: used })
}
