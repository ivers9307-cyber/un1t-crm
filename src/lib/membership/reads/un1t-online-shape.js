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

/**
 * A €0 one-time product is the free trial, never a class pack. An UNPRICED
 * product (price_cents null) is not €0: it is unknown, and never a trial.
 */
export const isTrialProduct = (p) => p?.type === 'one_time' && p.price_cents != null && Number(p.price_cents) === 0

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
 * UN1TRADAR.1 — the class-pack holders, as a Set of un1t_user_ids: a client
 * with credit_balance > 0, not unlimited, holding no active subscription, whose
 * LATEST pack transaction was a paid pack (the product's price when we can read
 * it, else what they paid; a €0 pack is never one). shapeCounts and the radar's
 * active base both read this one rule, so they can never disagree.
 */
export function packHolderIds({ subs = [], clients = [], packTxs = [], products = [] } = {}) {
  const activeUsers = new Set(subs.filter(isActiveSub).map((s) => s.un1t_user_id))

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
  return holders
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
  const holders = packHolderIds({ subs, clients, packTxs, products })

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

const DAY_MS = 86_400_000

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
 *   - a subscription whose own flag (status 'past_due', or `past_due_at` set)
 *     is raised while its status is on the live allowlist
 *     (UN1T_LIVE_SUB_STATUSES: active, past_due, trialing, paused, unpaid;
 *     compared trimmed and lower-cased). FAIL CLOSED: any other status (an
 *     ended spelling in UN1T_ENDED_SUB_STATUSES, or one we have never seen)
 *     cannot raise a row on its flag alone, so a cancelled subscription's old
 *     past_due_at is history; an invoice still open on it is real money and
 *     still raises a row.
 * `since` = earliest of `past_due_at` and the oldest surviving open invoice.
 * `amountCents` = the surviving open invoices' sum, or null when the only
 * signal is the subscription flag (no debt is ever estimated). When the
 * survivors span more than one currency (a missing currency beside a named one
 * counts as a second currency) BOTH `amountCents` and `currency` are null:
 * amounts are summed only across like currencies, and no label is shown on a
 * sum that was not made. Sorted by `since` ascending (no date last). Reads
 * nothing but the rows it is given.
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
    // null is a currency of its own here: a survivor with no currency beside a
    // named one cannot be added to it.
    const mixedCurrency = new Set(owed.map(currencyOf)).size > 1
    rows.push({
      contactId: sub?.contact_id ?? own.find((i) => i.contact_id)?.contact_id ?? null,
      un1tUserId: sub?.un1t_user_id ?? own[0]?.un1t_user_id ?? null,
      subscriptionId: sub?.un1t_id ?? group[0]?.subscription_id ?? null,
      productTitle: sub?.product_title ?? null,
      since,
      amountCents: owed.length && !mixedCurrency ? owed.reduce((sum, o) => sum + (Number(o.amount_cents) || 0), 0) : null,
      currency: currency && !mixedCurrency ? String(currency).toUpperCase() : null,
      openInvoiceIds: owed.map((o) => o.un1t_id),
      cancelAtPeriodEnd: sub?.cancel_at_period_end === true,
      pausedUntil: sub?.paused_until ?? null,
    })
  }
  return rows.sort((a, b) => (msOf(a.since) ?? Infinity) - (msOf(b.since) ?? Infinity))
}

// ---------------------------------------------------------------------------
// HATCHPIPE.2 — the pipeline snapshot and trial eligibility (spec A §6.2).
//
// Membership and the pipeline are separate per studio; only the contact is
// shared (Richard, 17 Oct 2026). So the snapshot is built from this studio's
// un1t_* rows alone, and the `contact` row given in lends exactly two fields
// (and only when this studio owns the contact). A dual-studio contact's
// Glofox columns never reach it.
// ---------------------------------------------------------------------------

/** Booking sources that put an aggregator user in the Gympass pile. */
export const UN1T_AGGREGATOR_GYMPASS_SOURCES = Object.freeze(['wellhub', 'gympass'])

/** gympass_member_id for a Wellhub / Gympass user whose booking carries no member ref. */
export const UN1T_AGGREGATOR_MARKER = 'un1t:aggregator'

const RECENT_BOOKINGS_LIMIT = 10
const RECURRING_TX_TYPES = Object.freeze(['sub_initial', 'sub_renewal'])

const lower = (v) => String(v ?? '').trim().toLowerCase()
const productOf = (productsById, id) => productsById?.get?.(id) ?? null

/** The latest / earliest of some timestamps (unreadable ones ignored), as given. */
const latestOf = (values) => values.reduce((best, v) => (
  msOf(v) != null && (best == null || msOf(v) > msOf(best)) ? v : best), null)
const earliestOf = (values) => values.reduce((best, v) => (
  msOf(v) != null && (best == null || msOf(v) < msOf(best)) ? v : best), null)

/**
 * A paid class pack: product_type 'pack', amount_cents > 0, not refunded, and
 * not a trial product (a trial is never a pack customer, whatever it cost). A
 * product we cannot read (deleted upstream) is not a trial product.
 */
function isPaidPack(t, productsById) {
  return lower(t?.product_type) === 'pack' && Number(t.amount_cents) > 0 && t.refunded !== true
    && !isTrialProduct(productOf(productsById, t.product_id))
}

// A fresh subscription that holds a membership: the snapshot's `member` rule.
const isMemberSub = (s) => MEMBER_STATUSES.includes(lower(s?.status))
  || (s?.paused_at != null && !UN1T_ENDED_SUB_STATUSES.includes(lower(s?.status)))

/** A recurring purchase: a sub_initial / sub_renewal, or a subscription product. */
const isRecurringTx = (t) => RECURRING_TX_TYPES.includes(lower(t?.type)) || lower(t?.product_type) === 'subscription'

/**
 * Every trial this person took at the studio, as { at, product_id }: a
 * transaction for a trial product (keyed on product id, never the title), a
 * €0 transaction whose product we cannot resolve or whose price is null
 * (deleted upstream, or not yet synced: it may well have been the trial, so it
 * counts; this only ever DENIES a second free trial), and each of spec D's ledger trial rows.
 */
function trialsTaken({ transactions = [], productsById, ledgerTrials = [] }) {
  const out = []
  for (const t of transactions) {
    if (!t) continue
    const product = productOf(productsById, t.product_id)
    // A €0 payment on a product we cannot price (unresolved, or resolved with a
    // null price) may well have been the trial: it counts. Deny-only.
    const unpricedFree = (product == null || product.price_cents == null)
      && t.amount_cents != null && Number(t.amount_cents) === 0
    if (isTrialProduct(product) || unpricedFree) out.push({ at: t.remote_created_at ?? null, product_id: t.product_id })
  }
  for (const l of ledgerTrials) if (l) out.push({ at: l.at ?? null, product_id: l.product_id ?? null })
  return out
}

/**
 * How a un1t.online credit balance splits between the trial and paid packs.
 *
 * Trial credits left = the newest trial product's `credits_per_period` minus
 * the `credit_charged` bookings made (`remote_created_at`) at or after that
 * trial, floored at 0 and capped at `credit_balance`. A trial whose product we
 * cannot read grants 0 (and is passed over for the newest trial whose product does
 * resolve); one with no readable date counts every charged booking.
 * Paid credits = `credit_balance` minus trial credits left, and only when a
 * paid pack exists (A-2: the whole balance is never read as "trial", and a
 * balance with no paid pack behind it is never read as paid).
 *
 * `newestTrialAt` is the newest trial's grant time and `newestTrialProductId`
 * its product (TRIALDONE.2: the trial's expiry is read off that product). When
 * several trials share the newest time, one whose product resolves names it.
 *
 * @returns {{ trialCreditsLeft: number, paidCredits: number, hasPaidPack: boolean,
 *   tookTrial: boolean, newestTrialAt: string|null, newestTrialProductId: string|null }}
 */
export function splitUn1tCredits({ client, transactions = [], productsById = new Map(), bookings = [], ledgerTrials = [] } = {}) {
  const balance = Math.max(0, Number(client?.credit_balance) || 0)
  const trials = trialsTaken({ transactions, productsById, ledgerTrials })
  const newestTrialAt = latestOf(trials.map((t) => t.at))
  const atNewest = newestTrialAt == null ? [] : trials.filter((t) => t.at === newestTrialAt)
  const newestTrial = atNewest.find((t) => productOf(productsById, t.product_id) != null) ?? atNewest[0] ?? null
  // The newest trial whose product resolves sets the grant; an unreadable one
  // (grants 0) is only the fallback when no trial resolves at all.
  const resolved = trials.filter((t) => productOf(productsById, t.product_id) != null)
  const newestResolvedAt = latestOf(resolved.map((t) => t.at))
  const newest = resolved.find((t) => t.at === newestResolvedAt && newestResolvedAt != null) ?? resolved[0]
    ?? trials.find((t) => t.at === newestTrialAt && newestTrialAt != null) ?? trials[0] ?? null
  const hasPaidPack = transactions.some((t) => isPaidPack(t, productsById))

  let trialCreditsLeft = 0
  if (newest) {
    const granted = Math.max(0, Number(productOf(productsById, newest.product_id)?.credits_per_period) || 0)
    const trialMs = msOf(newest.at)
    const used = bookings.filter((b) => b?.credit_charged === true
      && (trialMs == null || (msOf(b.remote_created_at) ?? -Infinity) >= trialMs)).length
    trialCreditsLeft = Math.min(Math.max(0, granted - used), balance)
  }
  return {
    trialCreditsLeft,
    paidCredits: hasPaidPack ? Math.max(0, balance - trialCreditsLeft) : 0,
    hasPaidPack,
    tookTrial: trials.length > 0,
    newestTrialAt,
    newestTrialProductId: newestTrial?.product_id ?? null,
  }
}

/**
 * TRIALDONE.2 — when the newest trial runs out: its grant time plus its
 * product's `expire_credits_in_days` (un1t_products.raw, selected as text) in
 * whole days of 24 hours (an instant, never re-zoned). Null when there is no
 * dated trial, its product cannot be read, or the product carries no positive
 * expiry. Read off the newest trial only: an older trial's expiry never stands
 * in for a newer one we cannot read.
 */
function trialExpiresAt(credits, productsById) {
  const grantMs = msOf(credits.newestTrialAt)
  if (grantMs == null) return null
  const raw = productOf(productsById, credits.newestTrialProductId)?.expire_credits_in_days
  const days = raw == null || raw === '' ? NaN : Number(raw)
  if (!Number.isFinite(days) || days <= 0) return null
  return new Date(grantMs + days * DAY_MS).toISOString()
}

/**
 * Aggregator users (A-3): a booking whose `source` is set and not 'direct', or
 * that carries an `external_member_ref`. A booking with no source at all is not
 * one. Wellhub / Gympass sources take the Gympass pile (the newest such
 * booking's ref, else the marker); every other aggregator the ClassPass pile.
 */
function aggregatorOf(bookings) {
  let classpass = false
  let gympass = false
  let ref = null
  let refMs = -Infinity
  // HATCHPIPE.5 — the first booking that put them in each pile (start, else
  // booking creation), for the board's stage date. Unread by the snapshot.
  let classpassSince = null
  let gympassSince = null
  const firstOf = (best, v) => (v != null && (best == null || v < best) ? v : best)
  for (const b of bookings) {
    if (!b) continue
    const source = lower(b.source)
    const extRef = b.external_member_ref != null && String(b.external_member_ref).trim() !== ''
      ? String(b.external_member_ref) : null
    if (!((source !== '' && source !== 'direct') || extRef != null)) continue
    const whenMs = msOf(b.starts_at) ?? msOf(b.remote_created_at)
    if (UN1T_AGGREGATOR_GYMPASS_SOURCES.includes(source)) {
      gympass = true
      gympassSince = firstOf(gympassSince, whenMs)
      const at = whenMs ?? -Infinity
      if (extRef != null && (ref == null || at > refMs)) { ref = extRef; refMs = at }
    } else {
      classpass = true
      classpassSince = firstOf(classpassSince, whenMs)
    }
  }
  return {
    classpass,
    gympassMemberId: gympass ? (ref ?? UN1T_AGGREGATOR_MARKER) : null,
    classpassSinceMs: classpassSince,
    gympassSinceMs: gympassSince,
  }
}

/**
 * One person's classifier input at one un1t.online studio: exactly the keys
 * `classifyContact` (shared/pipeline-classifier.js) reads, plus
 * `trial_expires_at` (TRIALDONE.2), which only the un1t board's classify
 * wrapper reads (shared/pipelines/acquisition-un1t.js: 2 attended + an expired
 * trial is trial_done). Built from this studio's rows only. Pure; reads
 * nothing but its arguments.
 *
 * Every list is this person's rows at `locationId` (the caller groups them):
 * `freshSubs` the FRESH un1t_subscriptions (see freshCutoff; a stale row never
 * makes a member), `transactions` all of them, `bookings` with their event's
 * `starts_at`, `memberships` contact_memberships with source 'un1t_online_api'
 * (a row naming another source is ignored), `ledgerTrials` spec D's
 * `op='trial'` done rows ([] until D ships).
 *
 * glofox_membership_status, first match wins (Glofox's order, spec §6.2):
 *   member        a fresh subscription in MEMBER_STATUSES, or paused and not ended
 *   credit_member paid credits > 0 (splitUn1tCredits)
 *   classpass_payg a non-Gympass aggregator user
 *   trial         a fresh 'trialing' subscription, or trial credits > 0
 *   ex_member     an ended membership, none active, and since its (latest) end
 *                 no paid pack bought and no class attended
 *   lead          everyone else
 *
 * `contact` lends ONLY pipeline_dismissed_at and last_lead_source_at, and only
 * when `contact.location_id === locationId` (a Stillorgan dismissal is a
 * Stillorgan judgement). Nothing else on it is read.
 *
 * @param {object} a
 * @param {object} a.client       un1t_clients row (un1t_user_id, credit_balance, credit_unlimited, last_attended_at, remote_created_at)
 * @param {object|null} a.contact { id, location_id, pipeline_dismissed_at, last_lead_source_at }
 * @param {string} a.locationId
 * @param {number} [a.now]        accepted for the interface; no rule here reads the clock
 *                                (classifyContact applies every time window itself)
 */
export function shapePipelineSnapshot({
  client, contact, locationId, freshSubs = [], transactions = [], productsById = new Map(),
  bookings = [], memberships = [], ledgerTrials = [], now: _now = Date.now(),
} = {}) {
  const credits = splitUn1tCredits({ client, transactions, productsById, bookings, ledgerTrials })
  const aggregator = aggregatorOf(bookings)
  const attendedStarts = bookings.filter((b) => lower(b?.status) === 'attended').map((b) => b.starts_at)
  const lastAttendedAt = latestOf([client?.last_attended_at, ...attendedStarts])

  const status = (() => {
    const subs = freshSubs.filter(Boolean)
    if (subs.some(isMemberSub)) return 'member'
    if (credits.paidCredits > 0) return 'credit_member'
    if (aggregator.classpass) return 'classpass_payg'
    if (subs.some((s) => lower(s.status) === 'trialing') || credits.trialCreditsLeft > 0) return 'trial'

    const own = memberships.filter((m) => m && (m.source == null || m.source === 'un1t_online_api'))
    const ended = own.filter((m) => lower(m.status) === 'ended')
    if (ended.length && !own.some((m) => lower(m.status) === 'active')) {
      const endMs = msOf(latestOf(ended.map((m) => m.ended_at)))
      const since = (v) => msOf(v) != null && (endMs == null || msOf(v) > endMs)
      const packSince = transactions.some((t) => isPaidPack(t, productsById) && since(t.remote_created_at))
      const attendedSince = since(client?.last_attended_at) || attendedStarts.some(since)
      if (!packSince && !attendedSince) return 'ex_member'
    }
    return 'lead'
  })()

  const recentBookings = bookings
    .filter((b) => msOf(b?.starts_at) != null)
    .sort((a, b) => msOf(b.starts_at) - msOf(a.starts_at))
    .slice(0, RECENT_BOOKINGS_LIMIT)
    .map((b) => ({
      attended: lower(b.status) === 'attended',
      status: String(b.status ?? '').toUpperCase(),
      time_start: Math.floor(msOf(b.starts_at) / 1000),
    }))

  // Unlimited → null; with a paid pack, the whole balance (null when unread);
  // else only the trial's own credits.
  const balance = client?.credit_balance == null ? null : Number(client.credit_balance)
  const trialCreditsRemaining = client?.credit_unlimited === true
    ? null
    : credits.hasPaidPack
      ? (Number.isFinite(balance) ? balance : null)
      : credits.trialCreditsLeft

  const owned = locationId != null && contact?.location_id != null && contact.location_id === locationId

  return {
    glofox_membership_status: status,
    glofox_membership_state: null,
    glofox_membership_expiry: null,
    last_attended_at: lastAttendedAt,
    total_attended_7d: null,
    total_attended_30d: null,
    last_payment_at: null,
    joined_at: latestOf([client?.remote_created_at, credits.newestTrialAt]),
    created_at: null,
    trial_credits_remaining: trialCreditsRemaining,
    recent_bookings: recentBookings,
    converted_at: firstSales(transactions.filter(Boolean))[0]?.remote_created_at ?? null,
    pack_customer_at: earliestOf(transactions.filter((t) => isPaidPack(t, productsById)).map((t) => t.remote_created_at)),
    pipeline_dismissed_at: owned ? (contact.pipeline_dismissed_at ?? null) : null,
    last_lead_source_at: owned ? (contact.last_lead_source_at ?? null) : null,
    gympass_member_id: aggregator.gympassMemberId,
    trial_expires_at: trialExpiresAt(credits, productsById),
  }
}

const isoOrNull = (ms) => (ms == null ? null : new Date(ms).toISOString())

/**
 * HATCHPIPE.5 — the evidence the board's date rules read
 * (un1t-pipeline-dates.js), from the SAME rows shapePipelineSnapshot was given
 * plus that snapshot. Kept apart from the snapshot so the snapshot stays
 * classify's input keys. Pure.
 *
 *   client_created_at   the (merged) un1t_clients.remote_created_at
 *   attended_starts     EVERY attended booking's start, oldest first (the
 *                       snapshot keeps only the newest 10 bookings); the same
 *                       "attended" test as recent_bookings (status
 *                       'attended', readable starts_at)
 *   attended_ends       TRIALDONE.2: the END of each booking in
 *                       attended_starts (same bookings, so a booking with no
 *                       readable start is left out), oldest first: the
 *                       event's ends_at, else its starts_at
 *   member_since        earliest remote_created_at of a fresh subscription
 *                       that holds a membership (the snapshot's member rule)
 *   classpass_since / gympass_since  first aggregator booking of each pile
 *   membership_ended_at latest end among this source's ended memberships
 *   dismissed_at        the snapshot's pipeline_dismissed_at (owned only)
 *   membership_status, joined_at, last_attended_at, converted_at,
 *   pack_customer_at, trial_expires_at  copied from the snapshot
 */
export function shapePipelineDateEvidence({
  client, freshSubs = [], bookings = [], memberships = [], snapshot = {},
} = {}) {
  const attendedStarts = bookings
    .filter((b) => lower(b?.status) === 'attended' && msOf(b?.starts_at) != null)
    .map((b) => b.starts_at)
    .sort((a, b) => msOf(a) - msOf(b))
  // the same bookings as attended_starts (a readable start), so both date
  // rules count the same classes; the end where the event has one
  const attendedEnds = bookings
    .filter((b) => lower(b?.status) === 'attended' && msOf(b?.starts_at) != null)
    .map((b) => (msOf(b.ends_at) != null ? b.ends_at : b.starts_at))
    .sort((a, b) => msOf(a) - msOf(b))
  const aggregator = aggregatorOf(bookings)
  const ended = memberships
    .filter((m) => m && (m.source == null || m.source === 'un1t_online_api') && lower(m.status) === 'ended')
  return {
    client_created_at: client?.remote_created_at ?? null,
    attended_starts: attendedStarts,
    attended_ends: attendedEnds,
    last_attended_at: snapshot.last_attended_at ?? null,
    joined_at: snapshot.joined_at ?? null,
    membership_status: snapshot.glofox_membership_status ?? null,
    converted_at: snapshot.converted_at ?? null,
    member_since: earliestOf(freshSubs.filter(isMemberSub).map((s) => s.remote_created_at)),
    pack_customer_at: snapshot.pack_customer_at ?? null,
    classpass_since: isoOrNull(aggregator.classpassSinceMs),
    gympass_since: isoOrNull(aggregator.gympassSinceMs),
    dismissed_at: snapshot.pipeline_dismissed_at ?? null,
    membership_ended_at: latestOf(ended.map((m) => m.ended_at)),
    trial_expires_at: snapshot.trial_expires_at ?? null,
  }
}

/**
 * May this person get the free trial at this studio? One definition for the
 * board, spec D's grant and spec E's upsell (R1, Richard 17 Oct 2026). Not
 * eligible, with the reasons in this order and each once:
 *   trial_used          a transaction for any trial product, or any ledger trial row
 *   membership_history  any subscription row (any status, no freshness), any
 *                       membership row given (the caller passes sources
 *                       un1t_online_api and un1t_online_export, any status), or a
 *                       recurring transaction (sub_initial / sub_renewal /
 *                       product_type 'subscription') even with no subscription row
 *   paid_pack           a paid pack (isPaidPack: the snapshot's definition)
 * Pure. A failed READ is the caller's to answer as "not eligible"; this only
 * judges rows it was given.
 *
 * @returns {{ eligible: boolean, reasons: Array<'trial_used'|'membership_history'|'paid_pack'> }}
 */
export function shapeTrialEligibility({
  transactions = [], productsById = new Map(), ledgerTrials = [], subscriptions = [], memberships = [],
} = {}) {
  const txs = transactions.filter(Boolean)
  const reasons = []
  if (trialsTaken({ transactions: txs, productsById, ledgerTrials }).length > 0) reasons.push('trial_used')
  if (subscriptions.some(Boolean) || memberships.some(Boolean) || txs.some(isRecurringTx)) reasons.push('membership_history')
  if (txs.some((t) => isPaidPack(t, productsById))) reasons.push('paid_pack')
  return { eligible: reasons.length === 0, reasons }
}
