// UN1TREAD.2 — the un1t.online adapter for the membership read seam.
//
// Every read returns EXACTLY what the Glofox function it mirrors returns, so
// MembershipPanel, StudioScorecard, the briefing and the phone's
// BusinessDashboard render unchanged:
//
//   membershipCounts  ← computeMembershipCounts   bare object; THROWS on error
//   membershipFlows   ← fetchMembershipFlows      bare object; THROWS on error
//   mrr               ← fetchMrr                  { success, data } | { success:false, error }
//   growth            ← fetchGrowth               { success, data } | { success:false, error }
//   engagement        ← fetchEngagement           { success, data } | { success:false, error }
//   revenueMtd        ← fetchRevenueMTD           { success, data } | { success:false, error }
//
//   pastDue           { success, data: PastDueRow[] } | { success:false, error }
//   paymentsFor       { success, data: { subscriptions, transactions, invoices, pastDue } } | { success:false, error }
//
// There is no `arrears`: the Glofox arrears summary is a different number from
// the per-subscription `pastDue` below (surviving open invoices, netted), so the
// surface shows "unavailable" rather than a Glofox-shaped zero (supportsRead
// false). `pastDue` / `paymentsFor` are un1t-only reads (HATCHPIPE.2): the
// Glofox adapter lacks them.
//
// SCOPE. Every query filters `<table>.location_id = locationId`, the studio the
// MEMBERSHIP is held at. Nothing here reads `contacts`, so a contact who lives
// at Stillorgan with an active Hatch subscription counts at Hatch (and still
// counts at Stillorgan if they are a Glofox member there). Service-role client;
// reads only, no writes. Every list read is range()+order() paginated.
import { selectAll, selectAllByKeys } from '@/lib/select-all'
import { logWarn } from '@/lib/log'
import { dayStrIn, dateKeyIn, monthStartMsIn, dayRangeMsIn, DEFAULT_TZ } from '@/lib/location-time'
import { monthKeys } from '@/lib/membership-flows'
import { windowBounds, windowDelta, computeEngagement, WINDOW_DAYS } from '@shared/studio-kpi-math'
import {
  shapeCounts, shapeMrr, shapeFlows, shapeRevenue,
  firstSales, engagementRows, cancelsComparable, MEMBER_STATUSES,
  shapePastDue, normaliseUn1tInvoiceStatus, glofoxInterval,
} from './un1t-online-shape'

const PAGE = 1000
const API_SOURCE = 'un1t_online_api'

// ---------------------------------------------------------------------------
// Paginated list readers. All throw on a failed page (selectAll); the
// fetch-style reads catch that and return { success:false, error }.
// ---------------------------------------------------------------------------
// STALE-ACTIVE GUARD. The sync (every 15 min) stamps each subscription it
// pulled with the run time, and a subscription the API stopped returning is
// never touched again, so its status stays 'active' for ever. A row absent from
// the latest pull therefore lags the newest by >= 15 min: only rows within
// STALE_WINDOW_MS (10 min) of the studio's newest `synced_at` are counted. If
// the sync itself stopped, every row is equally old and all still count (the
// freshness is relative, never against the clock; a dead sync is the sync
// health check's job).
const STALE_WINDOW_MS = 10 * 60 * 1000

const FRESH_TABLES = Object.freeze(['un1t_subscriptions', 'un1t_invoices', 'un1t_clients'])

/**
 * The freshness cutoff for one studio's rows in `table`: its newest `synced_at`
 * minus STALE_WINDOW_MS, as an ISO string. A row below it was not in the latest
 * pull. `null` when the studio has no rows in the table (or no readable
 * `synced_at`). Throws on a read error; any table but the three the sync stamps
 * with a run time is refused.
 */
export async function freshCutoff(db, table, locationId) {
  if (!FRESH_TABLES.includes(table)) {
    throw new Error(`freshCutoff: ${table} is not one of ${FRESH_TABLES.join(', ')}`)
  }
  const { data: newest, error } = await db
    .from(table)
    .select('synced_at')
    .eq('location_id', locationId)
    .order('synced_at', { ascending: false })
    .range(0, 0)
  if (error) throw new Error(error.message)
  const newestAt = Date.parse(newest?.[0]?.synced_at)
  if (!Number.isFinite(newestAt)) return null
  return new Date(newestAt - STALE_WINDOW_MS).toISOString()
}

// The statuses that hold a membership: see MEMBER_STATUSES in un1t-online-shape.js
// (the sync's MEMBERSHIP_ACTIVE_STATUSES minus 'trialing').
const listActiveSubs = async (db, loc) => {
  const cutoffIso = await freshCutoff(db, 'un1t_subscriptions', loc)
  if (cutoffIso === null) return [] // no subscription rows at all
  return selectAll((from, to) => db
    .from('un1t_subscriptions')
    .select('un1t_user_id, status, price_cents, billing_interval, billing_interval_count, paused_at, past_due_at')
    .eq('location_id', loc)
    .in('status', MEMBER_STATUSES)
    .gte('synced_at', cutoffIso)
    .order('id', { ascending: true })
    .range(from, to), { pageSize: PAGE })
}

const listPackClients = (db, loc) => selectAll((from, to) => db
  .from('un1t_clients')
  .select('un1t_user_id, credit_balance, credit_unlimited')
  .eq('location_id', loc)
  .gt('credit_balance', 0)
  .order('id', { ascending: true })
  .range(from, to), { pageSize: PAGE })

const listPackTransactions = (db, loc) => selectAll((from, to) => db
  .from('un1t_transactions')
  .select('un1t_user_id, product_id, product_type, amount_cents, remote_created_at')
  .eq('location_id', loc)
  .eq('product_type', 'pack')
  .order('id', { ascending: true })
  .range(from, to), { pageSize: PAGE })

const listProducts = (db, loc) => selectAll((from, to) => db
  .from('un1t_products')
  .select('un1t_id, type, price_cents')
  .eq('location_id', loc)
  .order('id', { ascending: true })
  .range(from, to), { pageSize: PAGE })

// The full sub_initial history (not just a window), so "a member's FIRST sale"
// sees an earlier purchase outside the window.
const listSubInitialTransactions = (db, loc) => selectAll((from, to) => db
  .from('un1t_transactions')
  .select('un1t_id, un1t_user_id, type, remote_created_at')
  .eq('location_id', loc)
  .eq('type', 'sub_initial')
  .order('id', { ascending: true })
  .range(from, to), { pageSize: PAGE })

const listEndedMemberships = (db, loc) => selectAll((from, to) => db
  .from('contact_memberships')
  .select('ended_at')
  .eq('location_id', loc)
  .eq('source', API_SOURCE)
  .eq('status', 'ended')
  .order('id', { ascending: true })
  .range(from, to), { pageSize: PAGE })

const listClientsAttendance = (db, loc) => selectAll((from, to) => db
  .from('un1t_clients')
  .select('un1t_user_id, bookings_30d_attended')
  .eq('location_id', loc)
  .order('id', { ascending: true })
  .range(from, to), { pageSize: PAGE })

const listTransactionAmounts = (db, loc, fromIso, toIso) => selectAll((from, to) => {
  let q = db
    .from('un1t_transactions')
    .select('amount_cents, refunded')
    .eq('location_id', loc)
    .gte('remote_created_at', fromIso)
  if (toIso) q = q.lt('remote_created_at', toIso)
  return q.order('id', { ascending: true }).range(from, to)
}, { pageSize: PAGE })

const errMessage = (e) => (e && e.message) || String(e)

// ---------------------------------------------------------------------------
// HATCHPIPE.2 — past due and per-contact payments. Subscriptions and invoices
// are read FRESH (see freshCutoff): a row the API stopped returning keeps its
// last status for ever, and a stale 'open' invoice is a debt that was settled
// (or never was) upstream. Freshness is judged against the STUDIO's newest
// pull, never the contact's, so a contactIds filter cannot make a row look new.
// ---------------------------------------------------------------------------
const SUB_COLS = 'un1t_id, un1t_user_id, contact_id, product_title, status, price_cents, currency, billing_interval, billing_interval_count, current_period_end, cancel_at_period_end, paused_until, past_due_at'
const INVOICE_COLS = 'un1t_id, un1t_user_id, contact_id, subscription_id, status, amount_cents, currency, remote_created_at'
const TX_COLS = 'remote_created_at, product_title, type, amount_cents, currency, refunded'
const KEY_CHUNK = 300
const DEFAULT_PAYMENTS_LIMIT = 25

/** Fresh rows of one sync-stamped table at a studio; `contactIds` (array) narrows to those contacts. */
async function listFresh(db, loc, table, cols, contactIds) {
  const cutoffIso = await freshCutoff(db, table, loc)
  if (cutoffIso === null) return []
  const page = (q, from, to) => q
    .eq('location_id', loc)
    .gte('synced_at', cutoffIso)
    .order('id', { ascending: true })
    .range(from, to)
  if (!contactIds) {
    return selectAll((from, to) => page(db.from(table).select(cols), from, to), { pageSize: PAGE })
  }
  return selectAllByKeys(
    contactIds,
    (keys, from, to) => page(db.from(table).select(cols).in('contact_id', keys), from, to),
    { chunkSize: KEY_CHUNK, pageSize: PAGE },
  )
}

const cleanIds = (ids) => [...new Set(ids.filter((id) => id != null && id !== ''))]

// Each distinct unknown spelling logs once per call, so a studio full of one
// odd status is one line, not one per invoice.
function warnUnknownStatuses(locationId, invoices) {
  const seen = new Set()
  for (const i of invoices) {
    if (seen.has(i.status) || normaliseUn1tInvoiceStatus(i.status) !== 'unknown') continue
    seen.add(i.status)
    logWarn('un1t-billing', 'unknown invoice status', { locationId, status: i.status })
  }
}

async function loadBilling(db, locationId, contactIds) {
  const [subs, invoices] = await Promise.all([
    listFresh(db, locationId, 'un1t_subscriptions', SUB_COLS, contactIds),
    listFresh(db, locationId, 'un1t_invoices', INVOICE_COLS, contactIds),
  ])
  warnUnknownStatuses(locationId, invoices)
  return { subs, invoices, pastDue: shapePastDue({ subs, invoices }) }
}

const newestFirst = (a, b) => {
  const am = Date.parse(a)
  const bm = Date.parse(b)
  return (Number.isFinite(bm) ? bm : -Infinity) - (Number.isFinite(am) ? am : -Infinity)
}

// ---------------------------------------------------------------------------
// The reads
// ---------------------------------------------------------------------------

/** ← computeMembershipCounts(db, locationId). Throws on a failed read. */
async function membershipCounts(db, locationId) {
  const [subs, clients, packTxs, products] = await Promise.all([
    listActiveSubs(db, locationId),
    listPackClients(db, locationId),
    listPackTransactions(db, locationId),
    listProducts(db, locationId),
  ])
  return shapeCounts({ subs, clients, packTxs, products })
}

/** ← fetchMrr(db, locationId). */
async function mrr(db, locationId) {
  if (!locationId) return { success: false, error: 'No location' }
  try {
    return { success: true, data: shapeMrr(await listActiveSubs(db, locationId)) }
  } catch (e) {
    return { success: false, error: errMessage(e) }
  }
}

/** ← fetchMembershipFlows(db, locationId, months, nowMs, { zone }). Throws on a failed read. */
async function membershipFlows(db, locationId, months = 12, nowMs = Date.now(), { zone = DEFAULT_TZ } = {}) {
  const keys = monthKeys(months, dayStrIn(nowMs, zone))
  const [saleTxs, endedRows] = await Promise.all([
    listSubInitialTransactions(db, locationId),
    listEndedMemberships(db, locationId),
  ])
  return shapeFlows({ saleTxs, endedRows, keys, zone })
}

/** ← fetchGrowth(db, locationId, now): the same two 28-day windows. */
async function growth(db, locationId, now = new Date()) {
  if (!locationId) return { success: false, error: 'No location' }
  const { startIso, prevStartIso } = windowBounds(now)
  const startMs = Date.parse(startIso)
  const prevStartMs = Date.parse(prevStartIso)
  const endMs = now.getTime()

  const countEnded = (fromIso, toIso) => {
    let q = db
      .from('contact_memberships')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .eq('source', API_SOURCE)
      .eq('status', 'ended')
      .gte('ended_at', fromIso)
    if (toIso) q = q.lt('ended_at', toIso)
    return q
  }

  try {
    const [saleTxs, cancels, prevCancels] = await Promise.all([
      listSubInitialTransactions(db, locationId),
      countEnded(startIso),
      countEnded(prevStartIso, startIso),
    ])
    const err = cancels.error || prevCancels.error
    if (err) return { success: false, error: err.message }

    let starts = 0
    let prevStarts = 0
    for (const t of firstSales(saleTxs)) {
      const at = Date.parse(t.remote_created_at)
      if (at >= startMs && at <= endMs) starts += 1
      else if (at >= prevStartMs && at < startMs) prevStarts += 1
    }
    const recurringCancels = cancels.count || 0
    const net = starts - recurringCancels
    const prevNet = prevStarts - (prevCancels.count || 0)
    return {
      success: true,
      data: {
        windowDays: WINDOW_DAYS,
        recurringStarts: starts,
        recurringCancels,
        netRecurring: net,
        netRecurringDelta: cancelsComparable(prevStartIso) ? windowDelta(net, prevNet) : null,
      },
    }
  } catch (e) {
    return { success: false, error: errMessage(e) }
  }
}

/** ← fetchEngagement(db, locationId). */
async function engagement(db, locationId) {
  if (!locationId) return { success: false, error: 'No location' }
  try {
    const [subs, clients] = await Promise.all([
      listActiveSubs(db, locationId),
      listClientsAttendance(db, locationId),
    ])
    return { success: true, data: computeEngagement(engagementRows({ subs, clients })) }
  } catch (e) {
    return { success: false, error: errMessage(e) }
  }
}

/**
 * ← fetchRevenueMTD(db, locationId, now, zone). The same two windows: this
 * month from the studio's 1st 00:00, against last month's 1st up to the same
 * day-of-month (clamped to last month's length), as half-open UTC ranges.
 */
async function revenueMtd(db, locationId, now = new Date(), zone = DEFAULT_TZ) {
  if (!locationId) return { success: false, error: 'No location' }
  const nowMs = now.getTime()
  const [y, m, d] = dateKeyIn(nowMs, zone).split('-').map(Number)
  const monthStartIso = new Date(monthStartMsIn(nowMs, zone)).toISOString()
  const prevY = m === 1 ? y - 1 : y
  const prevM = m === 1 ? 12 : m - 1
  const daysInPrev = new Date(Date.UTC(y, m - 1, 0)).getUTCDate()
  const pad = (n) => String(n).padStart(2, '0')
  const prevRange = dayRangeMsIn(
    `${prevY}-${pad(prevM)}-01`,
    `${prevY}-${pad(prevM)}-${pad(Math.min(d, daysInPrev))}`,
    zone,
  )
  try {
    const [current, previous] = await Promise.all([
      listTransactionAmounts(db, locationId, monthStartIso),
      listTransactionAmounts(db, locationId, new Date(prevRange.startMs).toISOString(), new Date(prevRange.endMs).toISOString()),
    ])
    return { success: true, data: shapeRevenue({ current, previous }) }
  } catch (e) {
    return { success: false, error: errMessage(e) }
  }
}

/**
 * Who is behind on payment at `locationId` (see shapePastDue): one row per
 * (member, subscription) with a surviving open invoice or a live past-due
 * subscription. `contactIds` narrows to those contacts (an empty list is an
 * empty answer with no query; a non-array is refused rather than widened to
 * the whole studio). Reads no `contacts`.
 */
async function pastDue(db, locationId, { contactIds } = {}) {
  if (!locationId) return { success: false, error: 'No location' }
  if (contactIds != null && !Array.isArray(contactIds)) return { success: false, error: 'contactIds must be an array' }
  const ids = contactIds == null ? null : cleanIds(contactIds)
  if (ids && ids.length === 0) return { success: true, data: [] }
  try {
    const { pastDue: rows } = await loadBilling(db, locationId, ids)
    return { success: true, data: rows }
  } catch (e) {
    return { success: false, error: errMessage(e) }
  }
}

/**
 * The payments picture for a contact (or a merged set of contacts) at one
 * studio: fresh subscriptions, the newest `limit` transactions and fresh
 * invoices, and the earliest-`since` past-due row (or null).
 */
async function paymentsFor(db, locationId, contactIds, { limit = DEFAULT_PAYMENTS_LIMIT } = {}) {
  if (!locationId) return { success: false, error: 'No location' }
  const ids = Array.isArray(contactIds) ? cleanIds(contactIds) : []
  if (ids.length === 0) {
    return { success: true, data: { subscriptions: [], transactions: [], invoices: [], pastDue: null } }
  }
  const n = Number.isFinite(Number(limit)) && Number(limit) >= 1 ? Math.floor(Number(limit)) : DEFAULT_PAYMENTS_LIMIT
  try {
    const [billing, txRows] = await Promise.all([
      loadBilling(db, locationId, ids),
      listNewestTransactions(db, locationId, ids, n),
    ])
    return {
      success: true,
      data: {
        subscriptions: billing.subs.map((s) => ({
          productTitle: s.product_title ?? null,
          status: s.status ?? null,
          priceCents: s.price_cents ?? null,
          currency: s.currency ?? null,
          interval: glofoxInterval(s.billing_interval, s.billing_interval_count),
          periodEnd: s.current_period_end ?? null,
          cancelAtPeriodEnd: s.cancel_at_period_end === true,
          pausedUntil: s.paused_until ?? null,
          pastDueAt: s.past_due_at ?? null,
        })),
        transactions: txRows.map((t) => ({
          at: t.remote_created_at ?? null,
          productTitle: t.product_title ?? null,
          type: t.type ?? null,
          amountCents: t.amount_cents ?? null,
          currency: t.currency ?? null,
          refunded: t.refunded === true,
        })),
        invoices: [...billing.invoices]
          .sort((a, b) => newestFirst(a.remote_created_at, b.remote_created_at))
          .slice(0, n)
          .map((i) => ({
            at: i.remote_created_at ?? null,
            status: normaliseUn1tInvoiceStatus(i.status),
            rawStatus: i.status ?? null,
            amountCents: i.amount_cents ?? null,
            currency: i.currency ?? null,
          })),
        pastDue: billing.pastDue[0] ?? null,
      },
    }
  } catch (e) {
    return { success: false, error: errMessage(e) }
  }
}

// The newest `limit` transactions across the contacts: each key chunk returns
// its own newest `limit` (one capped page, no pagination needed), then the
// union is cut again. Transactions are history, so they are not freshness-gated.
async function listNewestTransactions(db, loc, contactIds, limit) {
  const out = []
  for (let i = 0; i < contactIds.length; i += KEY_CHUNK) {
    const { data, error } = await db
      .from('un1t_transactions')
      .select(TX_COLS)
      .eq('location_id', loc)
      .in('contact_id', contactIds.slice(i, i + KEY_CHUNK))
      .order('remote_created_at', { ascending: false, nullsFirst: false })
      .range(0, limit - 1)
    if (error) throw new Error(error.message || String(error))
    out.push(...(data || []))
  }
  return out.sort((a, b) => newestFirst(a.remote_created_at, b.remote_created_at)).slice(0, limit)
}

export const un1tOnlineReads = Object.freeze({
  membershipCounts,
  mrr,
  membershipFlows,
  growth,
  engagement,
  revenueMtd,
  pastDue,
  paymentsFor,
})
