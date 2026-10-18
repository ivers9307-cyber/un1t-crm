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
import {
  MEMBER_STATUSES, UN1T_ENDED_SUB_STATUSES, UN1T_LIVE_SUB_STATUSES, glofoxInterval, packHolderIds, isActiveSub,
} from './un1t-online-shape'
import { isRealMembershipPlan } from '@/lib/churn-radar'
import { NON_MEMBER_STATUSES } from '@/lib/lead-radar'

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

// A subscription that holds a membership: MEMBER_STATUSES (active, past_due),
// exactly as shapeCounts counts one.
const isLiveSub = isActiveSub

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
  // Dearest monthly price; a tie goes to the newest subscription, then the
  // highest un1t_id, so the plan never depends on query order.
  const rank = (s) => [monthlyPrice(s), msOf(s.remote_created_at) ?? -Infinity, String(s.un1t_id ?? '')]
  const better = (a, b) => {
    const [pa, ta, ia] = rank(a)
    const [pb, tb, ib] = rank(b)
    return pa !== pb ? pa > pb : ta !== tb ? ta > tb : ia > ib
  }
  const sub = live.reduce((best, s) => (better(s, best) ? s : best))
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

/** The person-level columns every row carries, over all of one contact's un1t users. */
function baseRow(contactId, users, { clientsByUser, contactsById, newestBookingAtByUser, lastPaymentAtByUser, attended7d, bookings30d }) {
  const theirClients = users.flatMap((u) => clientsByUser.get(u) ?? [])
  return {
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
export function shapeRadarMembers(input = {}) {
  const { ctx: _ctx, ...out } = radarCore(input)
  return out
}

// shapeRadarMembers plus the per-person lookups (`ctx`) shapeWinbackRows reuses.
// Kept private: ctx holds contact names and must never reach a response or log.
function radarCore({
  subs = [], clients = [], packTxs = [], products = [], contactsById = new Map(),
  events = [], bookings = [], newestBookingAtByUser = new Map(), lastPaymentAtByUser = new Map(),
  nowMs,
} = {}) {
  const liveSubs = subs.filter(isLiveSub)
  const holders = packHolderIds({ subs, clients, packTxs, products })
  const { attended7d, bookings30d, skippedEvents } = bookingCounts({ events, bookings, nowMs })

  const clientsByUser = groupBy(clients, (c) => c.un1t_user_id)
  const subsByUser = groupBy(liveSubs, (s) => s.un1t_user_id)
  const productById = new Map(products.map((p) => [p.un1t_id, p]))
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

  const ctx = { clientsByUser, contactsById, newestBookingAtByUser, lastPaymentAtByUser, attended7d, bookings30d }
  const rows = []
  let members = 0
  let packHolders = 0
  for (const [contactId, users] of usersByContact) {
    const live = pickLiveMembership(users.flatMap((u) => subsByUser.get(u) ?? []), nowMs)
    const base = baseRow(contactId, users, ctx)
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
      glofox_membership_plan: packTx?.product_title ?? productById.get(packTx?.product_id)?.title ?? null,
      glofox_membership_state: 'active',
      glofox_membership_expiry: null,
      // the product's price when we can read it (as packHolderIds judges it), else what they paid
      glofox_membership_price_cents: productById.get(packTx?.product_id)?.price_cents ?? packTx?.amount_cents ?? null,
      glofox_billing_interval: null,
      cancel_at_period_end: false,
    })
  }
  return { rows, members, packHolders, unlinkedClients, skippedEvents, ctx }
}

/**
 * Win-back rows (spec B §2b, Claude's call 4): every live row from
 * shapeRadarMembers, plus an `ex_member` row for each contact who holds NO live
 * subscription and is not a pack holder now (both tested FIRST, so a current
 * member's ended export row is never evidence: mig 728 ended exactly those),
 * and has evidence of a past membership at this studio:
 *   (i)   a subscription row whose status is an ENDED spelling
 *         (UN1T_ENDED_SUB_STATUSES); a paused, unpaid, incomplete or blank
 *         status is not proof that a membership ended;
 *   (ii)  an active / past_due row the API stopped returning (synced_at older
 *         than freshCutoffIso: the mirror never deletes);
 *   (iii) an ended contact_memberships row here (un1t_online_api or
 *         un1t_online_export; the caller filters the source).
 * A 'trialing'-only history is not evidence. A contact holding any FRESH
 * subscription on the live allowlist (UN1T_LIVE_SUB_STATUSES: active,
 * past_due, trialing, paused, unpaid; or paused_at set on a status that is not
 * ended) is not an ex-member, and gets no radar row either while that status is
 * not active or past_due (paused people are spec A's members but the radar's
 * active base is MEMBER_STATUSES, as shapeCounts): spec A's board
 * counts a fresh paused one as a member. "No pack credits" means not a pack
 * holder (packHolderIds) and not unlimited: credits left from a €0 trial are
 * not pack credits, so they do not keep a former member off the list.
 *
 * Subscription statuses seen at Hatch (read-only check, 18 Oct 2026): all 26
 * rows 'active'; no cancelled row has been observed, so /subscriptions appears
 * to return active ones only, and (ii) and (iii) carry the evidence today. The
 * last five syncs report history.absent_from_pull = 0.
 *
 * Plan and price come from the person's newest non-trialing subscription row
 * (by remote_created_at) whose plan is a real membership (isRealMembershipPlan),
 * else their newest non-trialing row, else the ended membership's plan_name. Activity
 * columns come from their un1t_clients rows, as for members.
 *
 * @param {object} a  shapeRadarMembers' input (its `subs` is derived here from
 *                   `allSubs`: the fresh rows, by the same cutoff), plus:
 * @param {object[]} a.allSubs           every un1t_subscriptions row at the studio, any status and age (synced_at)
 * @param {string|null} a.freshCutoffIso freshCutoff('un1t_subscriptions'); null = no rows
 * @param {object[]} a.endedMemberships  ended contact_memberships { contact_id, plan_name, ended_at }
 * @returns {object[]}
 */
export function shapeWinbackRows({ allSubs = [], freshCutoffIso = null, endedMemberships = [], ...input } = {}) {
  const cutoffMs = msOf(freshCutoffIso)
  // One source of truth for "fresh": a row at or after the cutoff (every row
  // when there is no cutoff), so live and stale can never disagree.
  const isFresh = (s) => cutoffMs == null || (msOf(s.synced_at) ?? -Infinity) >= cutoffMs
  const freshSubs = allSubs.filter(isFresh)
  const { rows, ctx } = radarCore({ ...input, subs: freshSubs })
  const liveContacts = new Set(rows.map((r) => r.id))
  const { clients = [] } = input

  const contactOfUser = new Map()
  for (const c of clients) if (c.contact_id != null && !contactOfUser.has(c.un1t_user_id)) contactOfUser.set(c.un1t_user_id, c.contact_id)
  for (const s of allSubs) if (s.contact_id != null && s.un1t_user_id != null && !contactOfUser.has(s.un1t_user_id)) contactOfUser.set(s.un1t_user_id, s.contact_id)
  const contactOfSub = (s) => (s.un1t_user_id != null ? contactOfUser.get(s.un1t_user_id) : null) ?? s.contact_id ?? null

  // Contact → evidence (subscriptions, ended memberships) and its un1t users.
  const evidence = new Map()
  const entry = (id) => {
    if (!evidence.has(id)) evidence.set(id, { subs: [], ended: [], users: new Set() })
    return evidence.get(id)
  }
  // An unlimited-credit client holds credits now, so is not "no pack credits".
  const unlimitedContacts = new Set(clients.filter((c) => c.credit_unlimited === true && c.contact_id != null).map((c) => c.contact_id))

  const holdsLiveSub = new Set()
  for (const s of allSubs) {
    const contactId = contactOfSub(s)
    if (contactId == null) continue
    const status = lower(s.status)
    // spec A's member rule too: a fresh paused row that is not ended
    const pausedNotEnded = s.paused_at != null && !UN1T_ENDED_SUB_STATUSES.includes(status)
    if (isFresh(s) && (UN1T_LIVE_SUB_STATUSES.includes(status) || pausedNotEnded)) holdsLiveSub.add(contactId)
    const ended = UN1T_ENDED_SUB_STATUSES.includes(status)
    const staleLive = MEMBER_STATUSES.includes(status) && !isFresh(s)
    if (status !== 'trialing') entry(contactId).subs.push(s)
    if (ended || staleLive) entry(contactId).evident = true
  }
  for (const m of endedMemberships) {
    if (m?.contact_id == null) continue
    const e = entry(m.contact_id)
    e.ended.push(m)
    e.evident = true
  }
  for (const [user, contactId] of contactOfUser) if (evidence.has(contactId)) evidence.get(contactId).users.add(user)

  const out = [...rows]
  for (const [contactId, e] of evidence) {
    if (!e.evident || liveContacts.has(contactId) || holdsLiveSub.has(contactId) || unlimitedContacts.has(contactId)) continue
    const newestOf = (subs) => subs.reduce((best, s) => (
      best == null || (msOf(s.remote_created_at) ?? -Infinity) > (msOf(best.remote_created_at) ?? -Infinity) ? s : best), null)
    const newestSub = newestOf(e.subs.filter((s) => isRealMembershipPlan(s.product_title))) ?? newestOf(e.subs)
    const newestEnded = e.ended.reduce((best, m) => (
      best == null || (msOf(m.ended_at) ?? -Infinity) > (msOf(best.ended_at) ?? -Infinity) ? m : best), null)
    out.push({
      ...baseRow(contactId, [...e.users], ctx),
      glofox_membership_status: 'ex_member',
      glofox_membership_type: 'time',
      glofox_membership_plan: newestSub?.product_title ?? newestEnded?.plan_name ?? null,
      glofox_membership_state: null,
      glofox_membership_expiry: null,
      glofox_membership_price_cents: newestSub?.price_cents ?? null,
      glofox_billing_interval: newestSub ? glofoxInterval(newestSub.billing_interval, newestSub.billing_interval_count) : null,
      cancel_at_period_end: false,
    })
  }
  return out
}

/**
 * Lead-radar rows (spec B §2c), keyed exactly as lead-radar-data.js's
 * CONTACT_COLUMNS. The status is spec A's pipeline snapshot status, UNCHANGED,
 * so a person carries the same membership status on Hatch's board and its lead
 * radar (the board's own stage rules, dismissals and pack-customer piles stay
 * the board's, as the Glofox lead radar ignores them too):
 *   - a member or credit_member snapshot is never a lead row, whatever its
 *     bookings; an ex_member is not one either, unless it has a Gympass
 *     booking (below);
 *   - otherwise a snapshot carrying gympass_member_id is rendered
 *     'classpass_payg' on the LEAD ROW only, so the unchanged scorer sends it
 *     to the read-only aggregator view with the ClassPass rows, as the board's
 *     Gympass pile (an ex-member with a Gympass booking included: the board
 *     checks Gympass before ex-member).
 * joined_at and last_attended_at come from the snapshot; last_booked_at from
 * the person's newest booking here; name, email, phone and lead_source from
 * their contact. Membership is judged at this studio only (G1): the contact's
 * own glofox_membership_status is never read.
 *
 * `ownedWithoutClient` are contacts this studio OWNS with no un1t_clients row
 * here (lead forms, campaigns): each is a 'lead', joined_at from
 * contacts.joined_at, else created_at (Hatch was never bulk-imported, so
 * created_at is real there; Claude's call 5).
 *
 * @param {object} a
 * @param {{ contacts: object[], snapshots: Map<string, object> }} a.pipeline  pipelineInputs' data
 * @param {Map<string, object>} a.contactsById  { name, email, phone, lead_source }
 * @param {object[]} a.ownedWithoutClient       contacts { id, name, email, phone, lead_source, joined_at, created_at }
 * @param {Map<string, string>} a.newestBookingAtByContact
 * @returns {object[]}
 */
export function shapeLeadRows({
  pipeline = { contacts: [], snapshots: new Map() }, contactsById = new Map(),
  ownedWithoutClient = [], newestBookingAtByContact = new Map(),
} = {}) {
  const rows = []
  const seen = new Set()
  for (const person of pipeline.contacts ?? []) {
    const snapshot = pipeline.snapshots?.get?.(person.id)
    if (!snapshot || seen.has(person.id)) continue
    const snapStatus = snapshot.glofox_membership_status
    // A member or credit member is never a lead, Gympass bookings or not: the
    // board graduates them out of the Gympass pile (shared/pipeline-classifier.js).
    if (snapStatus === 'member' || snapStatus === 'credit_member') continue
    // The board checks Gympass BEFORE ex-member, so an ex-member with a Gympass
    // booking is in the Gympass pile there and the aggregator view here.
    const status = snapshot.gympass_member_id ? 'classpass_payg' : snapStatus
    if (!NON_MEMBER_STATUSES.includes(status)) continue
    seen.add(person.id)
    const c = contactsById.get(person.id) ?? {}
    rows.push({
      id: person.id,
      name: c.name ?? person.name ?? null,
      email: c.email ?? person.email ?? null,
      phone: c.phone ?? null,
      glofox_membership_status: status,
      last_attended_at: snapshot.last_attended_at ?? null,
      last_booked_at: newestBookingAtByContact.get(person.id) ?? null,
      joined_at: snapshot.joined_at ?? null,
      lead_source: c.lead_source ?? null,
    })
  }
  for (const c of ownedWithoutClient) {
    if (c?.id == null || seen.has(c.id)) continue
    seen.add(c.id)
    rows.push({
      id: c.id,
      name: c.name ?? null,
      email: c.email ?? null,
      phone: c.phone ?? null,
      glofox_membership_status: 'lead',
      last_attended_at: null,
      last_booked_at: newestBookingAtByContact.get(c.id) ?? null,
      joined_at: c.joined_at ?? c.created_at ?? null,
      lead_source: c.lead_source ?? null,
    })
  }
  return rows
}

// ---------------------------------------------------------------------------
// UN1TRADAR.2 — arrears from spec A's past-due read (spec B §4). Every un1t
// past-due row is a SUBSCRIPTION payment, so it lands in `byId` and
// `membershipById` (the Overdue tab). un1t.online exposes no unpaid
// non-membership charge and no awaiting-authorization charge, so those two
// maps stay empty and the fold says so (`unavailable`): every renderer shows
// "not available from un1t.online" for them, never 0.
// ---------------------------------------------------------------------------

export const UN1T_ARREARS_UNAVAILABLE = Object.freeze(['unpaidCharges', 'awaitingAuth'])

/**
 * Fold spec A's `pastDue` rows into fetchPastDue's shape:
 * `{ ids, byId, membershipById, chargesById, pendingById, unavailable, profileById }`.
 * Each aggregate is `{ amountCents, count, oldestDueAt, amountEstimated? }`:
 * a row whose amount un1t.online does not report counts the subscription's
 * price and marks the aggregate `amountEstimated: true` (bucketArrears drops a
 * zero amount, so the member would vanish from the Overdue tab; Claude's call
 * 11). Several rows for one contact sum, keeping the earliest `since`.
 * `profileById` is what the Overdue rows show for plan and last attended: from
 * un1t, because the contact row of a dual-studio member is Stillorgan's.
 *
 * @param {object[]} rows  spec A's pastDue data
 * @param {{ priceBySubscriptionId: Map<string, number>, lastAttendedByUser: Map<string, string> }} deps
 */
export function foldPastDue(rows = [], { priceBySubscriptionId = new Map(), lastAttendedByUser = new Map() } = {}) {
  const byId = new Map()
  const membershipById = new Map()
  const profileById = new Map()
  const add = (target, contactId, amountCents, since, estimated) => {
    const cur = target.get(contactId) || { amountCents: 0, count: 0, oldestDueAt: null }
    cur.amountCents += amountCents
    cur.count += 1
    if (since && (!cur.oldestDueAt || (msOf(since) ?? Infinity) < (msOf(cur.oldestDueAt) ?? Infinity))) cur.oldestDueAt = since
    if (estimated) cur.amountEstimated = true
    target.set(contactId, cur)
  }
  for (const r of rows) {
    if (r?.contactId == null) continue
    const estimated = r.amountCents == null
    const amount = estimated ? Number(priceBySubscriptionId.get(r.subscriptionId)) || 0 : Number(r.amountCents) || 0
    add(byId, r.contactId, amount, r.since ?? null, estimated)
    add(membershipById, r.contactId, amount, r.since ?? null, estimated)
    const prev = profileById.get(r.contactId)
    const attended = latestOf([prev?.last_attended_at, lastAttendedByUser.get(r.un1tUserId)])
    profileById.set(r.contactId, {
      glofox_membership_status: 'member',
      glofox_membership_type: 'time',
      glofox_membership_plan: prev?.glofox_membership_plan ?? r.productTitle ?? null,
      last_attended_at: attended,
    })
  }
  return {
    ids: new Set(byId.keys()),
    byId,
    membershipById,
    chargesById: new Map(),
    pendingById: new Map(),
    unavailable: [...UN1T_ARREARS_UNAVAILABLE],
    profileById,
  }
}

/** The business "In arrears" figure from a fold: { totalCents, memberCount, estimated }. */
export function arrearsFromFold(fold) {
  let totalCents = 0
  let estimated = false
  for (const agg of fold?.membershipById?.values?.() ?? []) {
    totalCents += agg.amountCents || 0
    if (agg.amountEstimated === true) estimated = true
  }
  return { totalCents, memberCount: fold?.membershipById?.size ?? 0, estimated }
}
