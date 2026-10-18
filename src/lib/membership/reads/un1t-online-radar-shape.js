// UN1TRADAR.1 — pure shaping of un1t.online rows into the churn radar's row
// contract (spec B §2), so the UNCHANGED scorer (src/lib/churn-radar.js) scores
// Hatch Street by Stillorgan's rules.
//
// No DB, no clock: the I/O module (./un1t-online-radar.js) hands rows in.
//
// The `glofox_` key names are the scorer's CONTRACT, not a claim about the
// data: every value below comes from this studio's un1t_* rows. A contact's own
// glofox_* columns, last_attended_at, plan and payments belong to the studio
// that owns the contact (Stillorgan, for a dual-studio member) and are NEVER
// read here: only `name` is taken from `contactsById`.
//
// Booking statuses in the mirror are LOWERCASE (booked, cancelled, attended,
// no_show: the OpenAPI UserBookingResponseDto). They are compared exactly as
// spelled; the uppercase Glofox constants are never reused.
import { MEMBER_STATUSES, glofoxInterval, packHolderIds } from './un1t-online-shape'

const DAY_MS = 86_400_000
const WINDOW_7D_MS = 7 * DAY_MS
const WINDOW_30D_MS = 30 * DAY_MS

/**
 * Which date stands in for Glofox's `glofox_membership_expiry`, which drives
 * the renewal-cliff detector. Decided by the read-only check of Stillorgan's
 * time-based members on 18 Oct 2026 (expiry null / ≤31 days / >31 days by
 * billing interval): 1 month 0/98/4, 3 months 0/19/39, 6 months 0/2/14,
 * 12 months 0/0/14, no interval 0/0/1. Glofox carries the NEXT CHARGE date
 * for rolling monthly plans, so the un1t equivalent is `current_period_end`
 * for every subscription: 'period_end'. ('cancelling_or_long' would map it
 * only for a cancelling or longer-than-monthly plan.)
 */
export const RENEWAL_EXPIRY_RULE = 'period_end'

const lower = (v) => String(v ?? '').trim().toLowerCase()
const msOf = (v) => {
  const n = Date.parse(v)
  return Number.isFinite(n) ? n : null
}
const latestOf = (values) => values.reduce((best, v) => (
  msOf(v) != null && (best == null || msOf(v) > msOf(best)) ? v : best), null)
const earliestOf = (values) => values.reduce((best, v) => (
  msOf(v) != null && (best == null || msOf(v) < msOf(best)) ? v : best), null)

/** A subscription that holds a membership: MEMBER_STATUSES (active, past_due), as shapeCounts. */
const isLiveSub = (s) => MEMBER_STATUSES.includes(s?.status)

/** Months in a subscription's billing period (1 when unreadable). */
function periodMonths(sub) {
  const c = Number(sub?.billing_interval_count)
  const n = Number.isFinite(c) && c > 0 ? c : 1
  const u = lower(sub?.billing_interval)
  if (u.startsWith('year')) return n * 12
  if (u.startsWith('week')) return (n * 12) / 52
  if (u.startsWith('day')) return n / 30
  return n
}

/** Monthly-normalised price in cents (0 when unpriced). */
const monthlyPrice = (sub) => {
  const p = Number(sub?.price_cents)
  return Number.isFinite(p) && p > 0 ? p / periodMonths(sub) : 0
}

/**
 * The scorer's `glofox_membership_expiry` for one subscription (see
 * RENEWAL_EXPIRY_RULE). 'cancelling_or_long' maps the period end only when the
 * subscription is cancelling or its period is longer than one month.
 */
export function expiryFor(sub, rule = RENEWAL_EXPIRY_RULE) {
  const end = sub?.current_period_end ?? null
  if (end == null) return null
  if (rule === 'period_end') return end
  if (sub.cancel_at_period_end === true || periodMonths(sub) > 1) return end
  return null
}

/**
 * One person's membership from their subscriptions. Live = status in
 * MEMBER_STATUSES. Plan and value come from the live subscription with the
 * highest monthly-normalised price (spec B Claude's call 2); `cancelling` only
 * when EVERY live subscription has cancel_at_period_end (a member dropping one
 * of two plans is not leaving); `paused` when every live subscription is paused
 * and its paused_until is null or still in the future. Null when nothing is live.
 *
 * @returns {{ sub: object, cancelling: boolean, paused: boolean }|null}
 */
export function pickLiveMembership(subsForUser = [], nowMs) {
  const live = subsForUser.filter(isLiveSub)
  if (live.length === 0) return null
  const sub = live.reduce((best, s) => (monthlyPrice(s) > monthlyPrice(best) ? s : best))
  const pausedNow = (s) => s.paused_at != null && (s.paused_until == null || (msOf(s.paused_until) ?? -Infinity) > nowMs)
  return {
    sub,
    cancelling: live.every((s) => s.cancel_at_period_end === true),
    paused: live.every(pausedNow),
  }
}

/** Group rows into Map<key, row[]>; rows with no key are dropped. */
function groupBy(rows, keyOf) {
  const out = new Map()
  for (const r of rows) {
    const k = keyOf(r)
    if (k == null) continue
    if (!out.has(k)) out.set(k, [])
    out.get(k).push(r)
  }
  return out
}

const sumOrNull = (values) => {
  const nums = values.filter((v) => v != null && Number.isFinite(Number(v))).map(Number)
  return nums.length ? nums.reduce((a, b) => a + b, 0) : null
}

/**
 * The 7-day attended and 30-day non-cancelled booking counts per un1t user,
 * from the mirror. An event counts when its start is in [now − window, now];
 * an event with no readable start is skipped (and counted).
 */
function bookingCounts({ events = [], bookings = [], nowMs }) {
  const startByEvent = new Map()
  let skippedEvents = 0
  for (const e of events) {
    const at = msOf(e?.starts_at)
    if (at == null) { skippedEvents += 1; continue }
    startByEvent.set(e.un1t_id, at)
  }
  const attended7d = new Map()
  const bookings30d = new Map()
  const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1)
  for (const b of bookings) {
    if (b?.un1t_user_id == null) continue
    const at = startByEvent.get(b.event_id)
    if (at == null || at > nowMs) continue
    const age = nowMs - at
    if (age <= WINDOW_30D_MS && b.status !== 'cancelled') bump(bookings30d, b.un1t_user_id)
    if (age <= WINDOW_7D_MS && b.status === 'attended') bump(attended7d, b.un1t_user_id)
  }
  return { attended7d, bookings30d, skippedEvents }
}

/**
 * The radar's active base at one un1t.online studio, in the scorer's row shape
 * (spec B §2 mapping table). One row per CONTACT: a person with two un1t
 * accounts at the studio is one row (membership over all their subscriptions,
 * 30-day counts and lifetime value summed, newest activity, earliest join).
 *
 *   member         a live subscription (MEMBER_STATUSES); type 'time'
 *   credit_member  a pack holder (packHolderIds, the rule shapeCounts uses);
 *                  type 'num_classes', plan = their latest pack's title
 *
 * A live user with no contact (on the client row, else the subscription) is
 * left out and counted in `unlinkedClients`.
 *
 * @param {object} a
 * @param {object[]} a.subs        fresh un1t_subscriptions at the studio
 * @param {object[]} a.clients     un1t_clients at the studio
 * @param {object[]} a.packTxs     un1t_transactions with product_type 'pack'
 * @param {object[]} a.products    un1t_products
 * @param {Map<string, {name}>} a.contactsById
 * @param {object[]} a.events      un1t_events { un1t_id, starts_at } in the 30-day window
 * @param {object[]} a.bookings    un1t_bookings { un1t_user_id, event_id, status } on those events
 * @param {Map<string, string>} a.newestBookingAtByUser  newest booking remote_created_at per user
 * @param {Map<string, string>} a.lastPaymentAtByUser    newest subscription payment per user
 * @param {number} a.nowMs
 * @returns {{ rows: object[], members: number, packHolders: number, unlinkedClients: number, skippedEvents: number }}
 */
export function shapeRadarMembers({
  subs = [], clients = [], packTxs = [], products = [], contactsById = new Map(),
  events = [], bookings = [], newestBookingAtByUser = new Map(), lastPaymentAtByUser = new Map(),
  nowMs,
} = {}) {
  const liveSubs = subs.filter(isLiveSub)
  const holders = packHolderIds({ subs, clients, packTxs, products })
  const { attended7d, bookings30d, skippedEvents } = bookingCounts({ events, bookings, nowMs })

  const clientsByUser = groupBy(clients, (c) => c.un1t_user_id)
  const subsByUser = groupBy(liveSubs, (s) => s.un1t_user_id)
  const productTitle = new Map(products.map((p) => [p.un1t_id, p.title ?? null]))
  const latestPack = new Map()
  for (const t of packTxs) {
    if (t.product_type !== 'pack' || t.un1t_user_id == null) continue
    const prev = latestPack.get(t.un1t_user_id)
    if (!prev || String(t.remote_created_at ?? '') >= String(prev.remote_created_at ?? '')) latestPack.set(t.un1t_user_id, t)
  }

  // Every user in the active population, and the contact each one is.
  const contactOf = (user) => clientsByUser.get(user)?.find((c) => c.contact_id != null)?.contact_id
    ?? subsByUser.get(user)?.find((s) => s.contact_id != null)?.contact_id
    ?? null
  const population = new Set([...subsByUser.keys(), ...holders])
  let unlinkedClients = 0
  const usersByContact = new Map()
  for (const user of population) {
    const contactId = contactOf(user)
    if (contactId == null) { unlinkedClients += 1; continue }
    if (!usersByContact.has(contactId)) usersByContact.set(contactId, [])
    usersByContact.get(contactId).push(user)
  }

  const rows = []
  let members = 0
  let packHolders = 0
  for (const [contactId, users] of usersByContact) {
    const theirClients = users.flatMap((u) => clientsByUser.get(u) ?? [])
    const live = pickLiveMembership(users.flatMap((u) => subsByUser.get(u) ?? []), nowMs)
    const base = {
      id: contactId,
      name: contactsById.get(contactId)?.name ?? null,
      trial_credits_remaining: sumOrNull(theirClients.map((c) => c.credit_balance)),
      last_attended_at: latestOf(theirClients.map((c) => c.last_attended_at)),
      last_booked_at: latestOf(users.map((u) => newestBookingAtByUser.get(u))),
      total_attended_30d: sumOrNull(theirClients.map((c) => c.bookings_30d_attended)),
      total_noshow_30d: sumOrNull(theirClients.map((c) => c.bookings_30d_no_show)),
      total_attended_7d: users.reduce((n, u) => n + (attended7d.get(u) ?? 0), 0),
      total_bookings_30d: users.reduce((n, u) => n + (bookings30d.get(u) ?? 0), 0),
      last_payment_at: latestOf(users.map((u) => lastPaymentAtByUser.get(u))),
      joined_at: earliestOf(theirClients.map((c) => c.remote_created_at)),
      lifetime_value_cents: sumOrNull(theirClients.map((c) => c.ltv_cents)),
      person_group_id: null,
    }
    if (live) {
      members += 1
      rows.push({
        ...base,
        glofox_membership_status: 'member',
        glofox_membership_type: 'time',
        glofox_membership_plan: live.sub.product_title ?? null,
        glofox_membership_state: live.paused ? 'paused' : 'active',
        glofox_membership_expiry: expiryFor(live.sub),
        glofox_membership_price_cents: live.sub.price_cents ?? null,
        glofox_billing_interval: glofoxInterval(live.sub.billing_interval, live.sub.billing_interval_count),
        cancel_at_period_end: live.cancelling,
      })
      continue
    }
    // Not a member, so every one of their users in the population is a pack holder.
    const pack = latestOf(users.map((u) => latestPack.get(u)?.remote_created_at))
    const packTx = users.map((u) => latestPack.get(u)).find((t) => t && t.remote_created_at === pack)
      ?? latestPack.get(users[0]) ?? null
    packHolders += 1
    rows.push({
      ...base,
      glofox_membership_status: 'credit_member',
      glofox_membership_type: 'num_classes',
      glofox_membership_plan: packTx?.product_title ?? productTitle.get(packTx?.product_id) ?? null,
      glofox_membership_state: 'active',
      glofox_membership_expiry: null,
      glofox_membership_price_cents: packTx?.amount_cents ?? null,
      glofox_billing_interval: null,
      cancel_at_period_end: false,
    })
  }
  return { rows, members, packHolders, unlinkedClients, skippedEvents }
}
