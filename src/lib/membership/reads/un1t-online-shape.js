// UN1TREAD.2 — pure shaping for the un1t.online membership reads.
//
// No DB, no clock: the queries in ./un1t-online.js hand rows in, the shapes
// the Glofox functions return (membership-snapshot.js, studio-kpis.js,
// membership-flows.js, dashboard-data.js) come out. Money is integer cents.
import { computeMrr } from '@shared/studio-kpi-math'
import { pctDelta } from '@shared/dashboard-metrics'
import { dayStrIn } from '@/lib/location-time'

// The first un1t.online sync (UN1TSYNC.1). contact_memberships only learned
// to END a membership from this day, so an earlier month has no cancellation
// data, which is "not tracked yet" (null), never 0. Sales are not gated: the
// transaction history was pulled whole.
export const UN1T_CANCEL_TRACKING_START = '2026-10-16'

/** True for a subscription that is billing a member: status 'active'. */
export const isActiveSub = (s) => s?.status === 'active'

/** An active subscription that is neither paused nor past due. */
export const isActiveRecurring = (s) => isActiveSub(s) && !s.paused_at && !s.past_due_at

/** A €0 one-time product is the free trial, never a class pack. */
export const isTrialProduct = (p) => p?.type === 'one_time' && Number(p.price_cents) === 0

// Glofox counts CONTACTS, so a member with two active subscriptions is one
// member. A row with no un1t_user_id cannot be matched and stands alone.
const memberKey = (s, i) => (s.un1t_user_id != null ? `u:${s.un1t_user_id}` : `row:${i}`)
const distinctMembers = (subs) => new Set(subs.map(memberKey)).size

const GLOFOX_INTERVALS = ['1 month', '3 months', '6 months', '12 months']

const plural = (n, unit) => (n === 1 ? `1 ${unit}` : `${n} ${unit}s`)

/**
 * un1t.online (unit 'month' | 'year' | 'week' | 'day', count) → the Glofox
 * interval spelling `computeMrr`/`recurring_by_interval` speak: '1 month',
 * '3 months', '12 months'. A year is 12 months a year, so a 12-month plan
 * prices at price/12 a month, never its full price. An unreadable unit or
 * count is the conservative monthly fallback (as intervalMonths does).
 */
export function glofoxInterval(unit, count) {
  const c = Number(count)
  const n = Number.isFinite(c) && c > 0 ? Math.round(c) : 1
  const u = String(unit || '').toLowerCase()
  if (u.startsWith('year')) return plural(n * 12, 'month')
  if (u.startsWith('month')) return plural(n, 'month')
  if (u.startsWith('week')) return plural(n, 'week')
  if (u.startsWith('day')) return plural(n, 'day')
  return '1 month'
}

/**
 * Same shape as computeMembershipCounts().
 *
 * @param {object} a
 * @param {object[]} a.subs      un1t_subscriptions (status active rows)
 * @param {object[]} a.clients   un1t_clients with credit_balance > 0
 * @param {object[]} a.packTxs   un1t_transactions with product_type 'pack'
 * @param {object[]} a.products  un1t_products
 */
export function shapeCounts({ subs = [], clients = [], packTxs = [], products = [] }) {
  const active = subs.filter(isActiveSub)
  const activeUsers = new Set(active.map((s) => s.un1t_user_id))

  const priceByProduct = new Map(products.map((p) => [p.un1t_id, p.price_cents]))
  const latestPack = new Map()
  for (const t of packTxs) {
    if (t.product_type !== 'pack' || t.un1t_user_id == null) continue
    const prev = latestPack.get(t.un1t_user_id)
    if (!prev || String(t.remote_created_at ?? '') >= String(prev.remote_created_at ?? '')) {
      latestPack.set(t.un1t_user_id, t)
    }
  }
  // A product we can read decides; one we cannot (deleted upstream) falls back
  // to what the member actually paid.
  const paidPack = (t) => {
    const price = priceByProduct.has(t.product_id) ? priceByProduct.get(t.product_id) : t.amount_cents
    return Number(price) > 0
  }

  const holders = new Set()
  for (const c of clients) {
    if (!(Number(c.credit_balance) > 0) || c.credit_unlimited === true) continue
    if (activeUsers.has(c.un1t_user_id)) continue
    const t = latestPack.get(c.un1t_user_id)
    if (t && paidPack(t)) holders.add(c.un1t_user_id)
  }

  // Members per interval: a member is counted once under each interval they hold.
  const perInterval = Object.fromEntries(GLOFOX_INTERVALS.map((k) => [k, new Set()]))
  active.forEach((s, i) => {
    const k = glofoxInterval(s.billing_interval, s.billing_interval_count)
    if (k in perInterval) perInterval[k].add(memberKey(s, i))
  })
  const byInterval = Object.fromEntries(GLOFOX_INTERVALS.map((k) => [k, perInterval[k].size]))

  const monthly = distinctMembers(active)
  return {
    total_members: monthly + holders.size,
    monthly_recurring: monthly,
    class_packs: holders.size,
    payg: 0,
    active_recurring: distinctMembers(active.filter(isActiveRecurring)),
    dead_packs: 0,
    detail: { recurring_by_interval: byInterval },
  }
}

/**
 * Same data as fetchMrr(): { mrrCents, recurringMembers, yieldCents }.
 * Only BILLING subscriptions count (active, not paused, not past due: fetchMrr
 * keeps glofox_membership_state = 'active' for the same reason). MRR sums every
 * such subscription's price (it is revenue); recurringMembers counts distinct
 * members, as Glofox counts contacts.
 */
export function shapeMrr(subs = []) {
  const billing = subs.filter(isActiveRecurring)
  const { mrrCents } = computeMrr(billing.map((s) => ({
    price_cents: s.price_cents,
    interval: glofoxInterval(s.billing_interval, s.billing_interval_count),
  })))
  const members = distinctMembers(billing)
  return {
    mrrCents,
    recurringMembers: members,
    yieldCents: members > 0 ? Math.round(mrrCents / members) : null,
  }
}

/**
 * Each member's FIRST new subscription: the earliest `sub_initial`
 * transaction per un1t_user_id (renewals are `sub_renewal`; a member who
 * rejoins is not a second sale). A row with no date cannot be placed.
 */
export function firstSales(txs = []) {
  const sorted = txs
    .filter((t) => t.type === 'sub_initial' && t.remote_created_at)
    .sort((a, b) => String(a.remote_created_at).localeCompare(String(b.remote_created_at)))
  const seen = new Set()
  const out = []
  for (const t of sorted) {
    const key = t.un1t_user_id ?? `tx:${t.un1t_id ?? t.id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
  }
  return out
}

/**
 * Same shape as fetchMembershipFlows(): monthly sales vs cancellations in
 * the location's zone. `keys` are 'YYYY-MM', oldest first.
 */
export function shapeFlows({ saleTxs = [], endedRows = [], keys, zone }) {
  const sales = Object.fromEntries(keys.map((k) => [k, 0]))
  for (const t of firstSales(saleTxs)) {
    const month = dayStrIn(t.remote_created_at, zone).slice(0, 7)
    if (month in sales) sales[month] += 1
  }
  const cancels = Object.fromEntries(keys.map((k) => [k, 0]))
  for (const r of endedRows) {
    if (!r.ended_at) continue
    const month = dayStrIn(r.ended_at, zone).slice(0, 7)
    if (month in cancels) cancels[month] += 1
  }
  const cancelStartMonth = UN1T_CANCEL_TRACKING_START.slice(0, 7)
  return {
    months: keys.map((month) => ({
      month,
      sales: sales[month],
      cancellations: month >= cancelStartMonth ? cancels[month] : null,
    })),
    cancelTrackingStart: UN1T_CANCEL_TRACKING_START,
  }
}

/** Is a comparison window that starts at `prevStartIso` fully tracked? */
export function cancelsComparable(prevStartIso) {
  return prevStartIso >= `${UN1T_CANCEL_TRACKING_START}T00:00:00.000Z`
}

/**
 * Same shape as fetchEngagement(): clients holding an active subscription,
 * through computeEngagement's { total_attended_30d } rows.
 */
export function engagementRows({ subs = [], clients = [] }) {
  const holders = new Set(subs.filter(isActiveSub).map((s) => s.un1t_user_id))
  return clients
    .filter((c) => holders.has(c.un1t_user_id))
    .map((c) => ({ total_attended_30d: c.bookings_30d_attended }))
}

/** Sum of settled (not refunded) money, and how many payments carried any. */
export function sumSettled(txs = []) {
  let totalCents = 0
  let paidCount = 0
  for (const t of txs) {
    if (t.refunded === true) continue
    const amt = Number(t.amount_cents) || 0
    totalCents += amt
    if (amt > 0) paidCount += 1
  }
  return { totalCents, paidCount }
}

/** Same data as fetchRevenueMTD(): { totalCents, paidCount, deltaPct }. */
export function shapeRevenue({ current = [], previous = [] }) {
  const cur = sumSettled(current)
  const prev = sumSettled(previous)
  return {
    totalCents: cur.totalCents,
    paidCount: cur.paidCount,
    deltaPct: pctDelta(cur.totalCents, prev.totalCents),
  }
}
