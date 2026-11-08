// pricing-tiers — TIERS.1: early bird, capacity tiers and a group price on
// an event (race_events.pricing_tiers, mig 818).
//
// A tier replaces the NON-MEMBER fee for the entry that buys it; member
// pricing is untouched. `resolveTier` picks ONE tier for the whole entry: the
// first in order that is open now (window), has room for every person in the
// entry (capacity, counted in PEOPLE whatever the event's capacity_mode) and
// fits the group (min_people). Only entries stamped with a pricing_tier_id
// consume tier seats (a staff-added or pre-tier entry never does).
//
// Every booking door prices through applyTierPricing (the public register
// route and race-register-solo.js) so the charge, the per-head breakdown on
// race_payments, the receipt and host revenue change nothing downstream: the
// tier price simply becomes `race.non_member_fee_cents` for computeTeamPricing.
// A failed sold-count read is load_failed: never price blind.
//
// The public block (publicPricing) carries the current and next tier and the
// group price, NEVER a sold count, a capacity or a spots-left figure
// (design decision 1): `limited: true` is all a buyer learns.

import { z } from 'zod'
import { LIVE_REGISTRATION_STATUSES } from './audience-filter'
import { holdingPlaces } from './entry-policy'
import { formatInZone, DEFAULT_TZ } from '@shared/zoned-time'
import { logError } from './log'

export const MAX_TIERS = 8

export const PricingTierSchema = z.object({
  id: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(60),
  price_cents: z.number().int().min(0).max(1_000_000),
  capacity: z.number().int().min(1).max(100000).nullable().optional(),
  starts_at: z.string().datetime().nullable().optional(),
  ends_at: z.string().datetime().nullable().optional(),
  min_people: z.number().int().min(2).max(50).nullable().optional(),
}).strict()

export const PricingTiersSchema = z.array(PricingTierSchema).max(MAX_TIERS).superRefine((tiers, ctx) => {
  const ids = new Set()
  for (const [i, t] of tiers.entries()) {
    if (ids.has(t.id)) ctx.addIssue({ code: 'custom', path: [i, 'id'], message: 'Each tier needs its own id.' })
    ids.add(t.id)
    if (t.starts_at && t.ends_at && Date.parse(t.ends_at) <= Date.parse(t.starts_at)) {
      ctx.addIssue({ code: 'custom', path: [i, 'ends_at'], message: 'A tier must end after it starts.' })
    }
  }
})

/** The event's tiers, [] when none or unreadable. */
export function resolvePricingTiers(race) {
  const parsed = PricingTiersSchema.safeParse(race?.pricing_tiers)
  return parsed.success ? parsed.data : []
}

/** Open now: after starts_at (if any) and strictly before ends_at (if any). */
export function tierIsOpen(tier, nowMs) {
  const starts = tier?.starts_at ? Date.parse(tier.starts_at) : null
  const ends = tier?.ends_at ? Date.parse(tier.ends_at) : null
  if (Number.isFinite(starts) && nowMs < starts) return false
  if (Number.isFinite(ends) && nowMs >= ends) return false
  return true
}

function hasRoom(tier, soldByTier, headcount) {
  if (tier.capacity == null) return true
  return (Number(soldByTier?.[tier.id]) || 0) + headcount <= tier.capacity
}
function fitsGroup(tier, headcount) {
  return tier.min_people == null || headcount >= tier.min_people
}

/**
 * The ONE tier an entry of `headcount` people gets now, or null (the base fee).
 * Pure.
 */
export function resolveTier({ tiers, nowMs, headcount, soldByTier }) {
  const n = Math.max(1, Number(headcount) || 1)
  for (const t of Array.isArray(tiers) ? tiers : []) {
    if (!tierIsOpen(t, nowMs)) continue
    if (!hasRoom(t, soldByTier, n)) continue
    if (!fitsGroup(t, n)) continue
    return t
  }
  return null
}

const PAGE = 1000

/**
 * People sold per tier: live entries (confirmed, or awaiting payment and still
 * holding their place under the event's policy) that carry a tier id, summed
 * by team size. Paged (the 1,000-row cap).
 * @returns {Promise<{ ok: true, soldByTier: Record<string, number> } | { ok: false, error: 'load_failed' }>}
 */
export async function loadSoldByTier(db, { eventId, race, nowMs = Date.now() }) {
  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('race_registrations')
      .select('id, status, registered_at, pricing_tier_id, team:teams ( size )')
      .eq('race_event_id', eventId)
      .not('pricing_tier_id', 'is', null)
      .in('status', LIVE_REGISTRATION_STATUSES)
      .order('id')
      .range(from, from + PAGE - 1)
    if (error) {
      logError('pricing-tiers', 'sold-by-tier read failed', { err: error, eventId })
      return { ok: false, error: 'load_failed' }
    }
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  const soldByTier = {}
  for (const r of holdingPlaces(rows, nowMs, race)) {
    const size = Math.max(1, Number(r.team?.size) || 1)
    soldByTier[r.pricing_tier_id] = (soldByTier[r.pricing_tier_id] || 0) + size
  }
  return { ok: true, soldByTier }
}

/**
 * The event as computeTeamPricing should see it: its non-member fee replaced
 * by the tier price when a tier applies. No tiers → no read, race unchanged.
 * @returns {Promise<{ ok: true, race: object, tier: object|null } | { ok: false, error: 'load_failed' }>}
 */
export async function applyTierPricing(db, { race, headcount, nowMs = Date.now() }) {
  const tiers = resolvePricingTiers(race)
  if (tiers.length === 0) return { ok: true, race, tier: null }
  const sold = await loadSoldByTier(db, { eventId: race.id, race, nowMs })
  if (!sold.ok) return sold
  const tier = resolveTier({ tiers, nowMs, headcount, soldByTier: sold.soldByTier })
  if (!tier) return { ok: true, race, tier: null }
  return { ok: true, race: { ...race, non_member_fee_cents: tier.price_cents }, tier }
}

/**
 * The per-tier shape in ONE key order with explicit nulls, so a list read
 * back from jsonb (Postgres reorders object keys) compares equal to the form's
 * list. null for no tiers.
 */
export function canonicalTiers(tiers) {
  if (!Array.isArray(tiers) || tiers.length === 0) return null
  return tiers.map((t) => ({
    id: t.id, name: t.name, price_cents: t.price_cents,
    capacity: t.capacity ?? null, starts_at: t.starts_at ?? null, ends_at: t.ends_at ?? null, min_people: t.min_people ?? null,
  }))
}

const DEFAULT_HEADCOUNTS = [1, 2, 3, 4, 5, 6, 7, 8]

/**
 * What a buyer may see: the tier one person gets now, what follows, the group
 * price, and `prices_by_headcount`: the per-person price the SERVER would
 * charge an entry of each allowed size right now (resolveTier, exactly as
 * applyTierPricing resolves it), so the page's total and the charge agree.
 * `group` is offered only when a group of `min_people` would actually get
 * that tier; `next` skips a tier that has ended or is full. Never a count.
 */
export function publicPricing({ race, nowMs = Date.now(), soldByTier = {} }) {
  const tiers = resolvePricingTiers(race)
  const base_cents = race?.non_member_fee_cents ?? null
  if (tiers.length === 0) return { base_cents, current: null, next: null, group: null, prices_by_headcount: null }
  const priceFor = (n) => resolveTier({ tiers, nowMs, headcount: n, soldByTier })?.price_cents ?? base_cents
  const current = resolveTier({ tiers, nowMs, headcount: 1, soldByTier })
  let next = null
  if (current) {
    const after = tiers.slice(tiers.indexOf(current) + 1).find((t) => t.min_people == null
      && !(t.ends_at && nowMs >= Date.parse(t.ends_at))
      && hasRoom(t, soldByTier, 1))
    if (after) next = { name: after.name, price_cents: after.price_cents, starts_at: after.starts_at ?? null }
  }
  const g = tiers.find((t) => t.min_people != null && resolveTier({ tiers, nowMs, headcount: t.min_people, soldByTier })?.id === t.id)
  const sizes = Array.isArray(race?.allowed_team_sizes) && race.allowed_team_sizes.length > 0 ? race.allowed_team_sizes : DEFAULT_HEADCOUNTS
  const prices_by_headcount = Object.fromEntries(sizes.map((n) => [n, priceFor(n)]))
  return {
    base_cents,
    current: current ? { id: current.id, name: current.name, price_cents: current.price_cents, ends_at: current.ends_at ?? null, limited: current.capacity != null } : null,
    next,
    group: g ? { min_people: g.min_people, price_cents: g.price_cents } : null,
    prices_by_headcount,
  }
}

const euro = (cents) => `€${(Number(cents) / 100).toFixed(2)}`

/** The price row on the public page. */
export function tierPriceLabel(pricing, { zone = DEFAULT_TZ } = {}) {
  const base = pricing?.base_cents
  const current = pricing?.current
  if (!current) return base == null ? 'Free' : `${euro(base)} per person`
  let s = `${current.name} ${euro(current.price_cents)}`
  if (current.ends_at) s += ` until ${formatInZone(new Date(current.ends_at), zone, { weekday: 'short', day: 'numeric', month: 'short' }, 'en-GB')}`
  else if (current.limited) s += ' (limited)'
  if (pricing.next) s += `, then ${euro(pricing.next.price_cents)}`
  return s
}

/** "3+ people: €28.00 each" or ''. */
export function groupPriceLabel(pricing) {
  const g = pricing?.group
  return g ? `${g.min_people}+ people: ${euro(g.price_cents)} each` : ''
}

/** The per-person non-member fee the live total should use for `headcount`:
 * the server's own table first, else the one-person tier, else base. */
export function effectiveNonMemberFee(pricing, headcount) {
  if (!pricing) return null
  const n = Math.max(1, Number(headcount) || 1)
  const table = pricing.prices_by_headcount
  if (table && table[n] != null) return table[n]
  if (pricing.current) return pricing.current.price_cents
  return pricing.base_cents ?? null
}
