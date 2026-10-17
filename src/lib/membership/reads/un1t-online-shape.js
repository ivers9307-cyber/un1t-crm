// UN1TREAD.2 — pure shaping for the un1t.online membership reads.
//
// No DB, no clock: the queries in ./un1t-online.js hand rows in, the shapes
// the Glofox functions return (membership-snapshot.js, studio-kpis.js,
// membership-flows.js, dashboard-data.js) come out. Money is integer cents.
import { computeMrr } from '@shared/studio-kpi-math'
import { pctDelta } from '@shared/dashboard-metrics'
import { dayStrIn } from '@/lib/location-time'
import { RETRY_NET_WINDOW_DAYS } from '@/lib/glofox-arrears'

// The first un1t.online sync (UN1TSYNC.1). contact_memberships only learned
// to END a membership from this day, so an earlier month has no cancellation
// data, which is "not tracked yet" (null), never 0. Sales are not gated: the
// transaction history was pulled whole.
export const UN1T_CANCEL_TRACKING_START = '2026-10-16'

// The statuses that hold a membership here: the sync's MEMBERSHIP_ACTIVE_STATUSES
// (src/lib/un1t-online-map.js: active, trialing, past_due) MINUS 'trialing'. A
// trialing subscription is a free trial in progress, not a paying member, and
// the Glofox numbers these mirror do not count a trialist as a member either.
// 'past_due' is a member whose payment failed: still a member, not yet income.
export const MEMBER_STATUSES = Object.freeze(['active', 'past_due'])

// A subscription spelled as ended. The live 18 Oct 2026 data only carries
// 'active' (26 rows), so every spelling here is defensive: Stripe spells the
// ended state 'canceled', other sources 'cancelled', 'ended' or 'expired'.
// A past_due_at on one of these is history, not a debt.
export const UN1T_ENDED_SUB_STATUSES = Object.freeze(['canceled', 'cancelled', 'ended', 'expired', 'incomplete_expired'])

// The subscription statuses whose `past_due_at` / 'past_due' flag is a live
// signal. FAIL CLOSED: a status outside this list (an ended spelling we did not
// foresee, a new one the API grows) cannot raise a past-due row on its own.
export const UN1T_LIVE_SUB_STATUSES = Object.freeze(['active', 'past_due', 'trialing', 'paused', 'unpaid'])

// A paid invoice only pays off an open one inside the same retry window the
// Glofox arrears code uses (RETRY_NET_WINDOW_DAYS): a same-amount payment weeks
// later is the next period's bill, not the retry.
export const UN1T_RETRY_NET_WINDOW_MS = RETRY_NET_WINDOW_DAYS * 86_400_000

/** True for a subscription that holds a membership: status 'active' or 'past_due'. */
export const isActiveSub = (s) => MEMBER_STATUSES.includes(s?.status)

/** A subscription that is billing NOW: status 'active', neither paused nor past due. */
export const isActiveRecurring = (s) => s?.status === 'active' && !s.paused_at && !s.past_due_at

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
 * Only BILLING subscriptions count (status 'active', not paused, not past due: fetchMrr
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

// ---------------------------------------------------------------------------
// HATCHPIPE.2 — invoices and past due.
// ---------------------------------------------------------------------------
const INVOICE_STATUS = Object.freeze({
  paid: 'paid',
  open: 'open', past_due: 'open', unpaid: 'open', failed: 'open', uncollectible: 'open',
  void: 'void', draft: 'void', deleted: 'void',
  refunded: 'refunded',
})

/**
 * un1t.online invoice status (a bare string, no published enum) →
 * 'paid' | 'open' | 'void' | 'refunded' | 'unknown'. Case-insensitive. Only
 * 'open' is ever owed; 'unknown' is shown verbatim to staff and never counted.
 * Live 18 Oct 2026: every invoice is 'paid', so the other spellings are defensive.
 */
export function normaliseUn1tInvoiceStatus(raw) {
  if (typeof raw !== 'string') return 'unknown'
  return INVOICE_STATUS[raw.trim().toLowerCase()] ?? 'unknown'
}

const msOf = (v) => {
  const n = Date.parse(v)
  return Number.isFinite(n) ? n : null
}

const currencyOf = (i) => (i?.currency ? String(i.currency).toUpperCase() : null)

/**
 * The open invoices that survive netting. An open invoice is paid off when a
 * paid invoice on the same subscription has the same amount, the same currency
 * (upper-cased) and a LATER
 * `remote_created_at` (a retry that took). Each paid invoice nets at most one
 * open invoice: the latest earlier one still standing. An invoice with no
 * readable date can neither net nor be netted.
 */
function survivingOpen(invoices) {
  const open = invoices.filter((i) => normaliseUn1tInvoiceStatus(i.status) === 'open')
  const paid = invoices
    .filter((i) => normaliseUn1tInvoiceStatus(i.status) === 'paid' && msOf(i.remote_created_at) != null)
    .sort((a, b) => msOf(a.remote_created_at) - msOf(b.remote_created_at))
  const netted = new Set()
  for (const p of paid) {
    const pAt = msOf(p.remote_created_at)
    let pick = null
    for (const o of open) {
      const oAt = msOf(o.remote_created_at)
      if (netted.has(o) || oAt == null || oAt >= pAt || pAt - oAt > UN1T_RETRY_NET_WINDOW_MS) continue
      if (Number(o.amount_cents) !== Number(p.amount_cents)) continue
      if (currencyOf(o) !== currencyOf(p)) continue
      if (pick == null || oAt > msOf(pick.remote_created_at)) pick = o
    }
    if (pick) netted.add(pick)
  }
  return open
    .filter((o) => !netted.has(o))
    .sort((a, b) => (msOf(a.remote_created_at) ?? Infinity) - (msOf(b.remote_created_at) ?? Infinity))
}

/**
 * Who is behind on payment at one studio, from FRESH rows the caller has
 * already filtered (see freshCutoff). A row per (un1t_user_id, subscription):
 *   - a surviving open invoice (see survivingOpen), or
 *   - a subscription with status 'past_due' or `past_due_at` set that has NOT
 *     ended (UN1T_ENDED_SUB_STATUSES: a cancelled subscription's old
 *     past_due_at is history, though an invoice still open on it is real money).
 * `since` = earliest of `past_due_at` and the oldest surviving open invoice.
 * `amountCents` = the surviving open invoices' sum, or null when the only
 * signal is the subscription flag (no debt is ever estimated) or when the
 * survivors span more than one currency (amounts are summed only across like
 * currencies). Sorted by
 * `since` ascending (no date last). Reads nothing but the rows it is given.
 *
 * @param {object} a
 * @param {object[]} a.subs      un1t_subscriptions
 * @param {object[]} a.invoices  un1t_invoices
 * @returns {{contactId: string|null, un1tUserId: string|null, subscriptionId: string|null,
 *   productTitle: string|null, since: string|null, amountCents: number|null, currency: string|null,
 *   openInvoiceIds: string[], cancelAtPeriodEnd: boolean, pausedUntil: string|null}[]}
 */
export function shapePastDue({ subs = [], invoices = [] } = {}) {
  const keyOf = (user, subscription) => `${user ?? ''}\u0000${subscription ?? ''}`
  const subByKey = new Map()
  for (const s of subs) subByKey.set(keyOf(s.un1t_user_id, s.un1t_id), s)

  // An invoice naming neither a member nor a subscription cannot be grouped with
  // anything: it gets a bucket of its own, never the shared ''/'' one.
  const nameless = (v) => v == null || v === ''
  const invoiceKey = (i) => (nameless(i.un1t_user_id) && nameless(i.subscription_id)
    ? `orphan\u0000${i.un1t_id}`
    : keyOf(i.un1t_user_id, i.subscription_id))

  const orphanKeys = new Set()
  const invoicesByKey = new Map()
  for (const i of invoices) {
    const k = invoiceKey(i)
    if (nameless(i.un1t_user_id) && nameless(i.subscription_id)) orphanKeys.add(k)
    if (!invoicesByKey.has(k)) invoicesByKey.set(k, [])
    invoicesByKey.get(k).push(i)
  }

  // Fail closed: only a status on the live allowlist lets the subscription's own
  // flag (status 'past_due', or a past_due_at) raise a row.
  const flagged = (s) => {
    const status = String(s.status ?? '').trim().toLowerCase()
    return UN1T_LIVE_SUB_STATUSES.includes(status) && (status === 'past_due' || s.past_due_at != null)
  }

  const keys = new Set(invoicesByKey.keys())
  for (const [k, s] of subByKey) if (flagged(s)) keys.add(k)

  const rows = []
  for (const k of keys) {
    const sub = subByKey.get(k) ?? null
    const group = invoicesByKey.get(k) ?? []
    const owed = survivingOpen(group)
    const subFlag = sub != null && flagged(sub)
    if (owed.length === 0 && !subFlag) continue

    const candidates = owed.map((o) => o.remote_created_at).filter((v) => msOf(v) != null)
    if (subFlag && msOf(sub.past_due_at) != null) candidates.push(sub.past_due_at)
    const since = candidates.length
      ? candidates.reduce((min, v) => (msOf(v) < msOf(min) ? v : min))
      : null

    const currency = owed.find((o) => o.currency)?.currency ?? sub?.currency ?? group.find((i) => i.currency)?.currency ?? null
    // Identity comes only from rows that carry this group's own identifier: the
    // subscription row, else an invoice naming the same member.
    const userPart = k.split('\u0000')[0]
    const own = orphanKeys.has(k) ? group : group.filter((i) => String(i.un1t_user_id ?? '') === userPart)
    const mixedCurrency = new Set(owed.map(currencyOf).filter(Boolean)).size > 1
    rows.push({
      contactId: sub?.contact_id ?? own.find((i) => i.contact_id)?.contact_id ?? null,
      un1tUserId: sub?.un1t_user_id ?? own[0]?.un1t_user_id ?? null,
      subscriptionId: sub?.un1t_id ?? group[0]?.subscription_id ?? null,
      productTitle: sub?.product_title ?? null,
      since,
      amountCents: owed.length && !mixedCurrency ? owed.reduce((sum, o) => sum + (Number(o.amount_cents) || 0), 0) : null,
      currency: currency ? String(currency).toUpperCase() : null,
      openInvoiceIds: owed.map((o) => o.un1t_id),
      cancelAtPeriodEnd: sub?.cancel_at_period_end === true,
      pausedUntil: sub?.paused_until ?? null,
    })
  }
  return rows.sort((a, b) => (msOf(a.since) ?? Infinity) - (msOf(b.since) ?? Infinity))
}
