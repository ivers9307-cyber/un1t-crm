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
// There is no `arrears`: un1t past-due amounts are not synced, so the surface
// shows "unavailable" rather than a Glofox-shaped zero (supportsRead false).
//
// SCOPE. Every query filters `<table>.location_id = locationId`, the studio the
// MEMBERSHIP is held at. Nothing here reads `contacts`, so a contact who lives
// at Stillorgan with an active Hatch subscription counts at Hatch (and still
// counts at Stillorgan if they are a Glofox member there). Service-role client;
// reads only, no writes. Every list read is range()+order() paginated.
import { selectAll } from '@/lib/select-all'
import { dayStrIn, dateKeyIn, monthStartMsIn, dayRangeMsIn, DEFAULT_TZ } from '@/lib/location-time'
import { monthKeys } from '@/lib/membership-flows'
import { windowBounds, windowDelta, computeEngagement, WINDOW_DAYS } from '@shared/studio-kpi-math'
import {
  shapeCounts, shapeMrr, shapeFlows, shapeRevenue,
  firstSales, engagementRows, cancelsComparable, MEMBER_STATUSES,
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

export const un1tOnlineReads = Object.freeze({
  membershipCounts,
  mrr,
  membershipFlows,
  growth,
  engagement,
  revenueMtd,
})
