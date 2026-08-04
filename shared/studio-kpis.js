// shared/studio-kpis.js
//
// STUDIO-KPI.1 — IO for the Studio scorecard (revenue-focused KPIs by
// location). Same contract as dashboard-data.js: every fetcher takes a
// Supabase client + locationId, returns { success, data?, error? } with
// a flat data shape. Pure — no React/Next/src-lib imports, Metro-safe.
// NOTE mobile adoption needs a service-role /api route (the
// DASH-M.1 pattern): membership_transitions and ad_insights_daily have
// RLS-no-policies, so mobile's authenticated client reads nothing from
// them directly. Pure shaping lives in ./studio-kpi-math.js.
//
// Data-source freshness the UI must respect (render honestly, not 0):
// - membership_transitions exists since 2026-07-29 (mig 456); rows
//   before mig 480 carry no stamped price → summariseCancels estimates.
// - class_occurrences/class_bookings sync since ~2026-06-17, Stillorgan
//   only (Hatch has no Glofox connection) → fetchFloor returns
//   noData: true when a location has no occurrences in the window.

import { isoDate, startOfMonth } from './dashboard-data.js'
import {
  computeMrr, summariseCancels, computeEngagement, computeFloor,
  computeActivation, ACTIVATION_WINDOW_DAYS,
} from './studio-kpi-math.js'

const MEMBER_STATUSES = ['member', 'credit_member']
const PAGE = 1000
const HARD_LIMIT = 100_000

// Paginate a select past the 1k-row cap. makeQuery(from, to) must apply
// .order() itself so pages are stable. Inline here (not src/lib/select-all
// — this file is the mobile seam and cannot import src/lib).
async function selectAll(makeQuery) {
  const rows = []
  for (let from = 0; from < HARD_LIMIT; from += PAGE) {
    const { data, error } = await makeQuery(from, from + PAGE - 1)
    if (error) return { error }
    if (!Array.isArray(data) || data.length === 0) break
    rows.push(...data)
    if (data.length < PAGE) break
  }
  return { rows }
}

function daysAgoIso(days, now = new Date()) {
  const d = new Date(now)
  d.setDate(d.getDate() - days)
  return d.toISOString()
}

// ============================================================
// MRR + yield — the recurring base priced member-by-member.
// ============================================================

export async function fetchMrr(supabase, locationId) {
  if (!locationId) return { success: false, error: 'No location' }
  // state='active' — paused (planned freeze) and locked (payment
  // failing) memberships aren't billing this month, so they count
  // toward the base cards elsewhere but not toward MRR; locked value
  // surfaces via the arrears cell instead.
  const res = await selectAll((from, to) => supabase
    .from('contacts')
    .select('glofox_membership_price_cents, glofox_billing_interval')
    .eq('location_id', locationId)
    .in('glofox_membership_status', MEMBER_STATUSES)
    .eq('glofox_membership_type', 'time')
    .eq('glofox_membership_state', 'active')
    .order('id', { ascending: true })
    .range(from, to))
  if (res.error) return { success: false, error: res.error.message }
  const mrr = computeMrr(res.rows.map(r => ({
    price_cents: r.glofox_membership_price_cents,
    interval: r.glofox_billing_interval,
  })))
  return { success: true, data: mrr }
}

// ============================================================
// Base growth MTD — joins, starts, cancels, net.
// ============================================================

// New-lead volume lives in fetchFunnelCounts' `entered` (joined_at is
// stamped for every Glofox contact, leads included) — this fetcher is
// strictly the recurring-membership flow. New MEMBERS this month =
// fetchFunnelCounts' `converted` (write-once converted_at, mig 350).
export async function fetchGrowth(supabase, locationId, now = new Date()) {
  if (!locationId) return { success: false, error: 'No location' }
  const monthStartIso = startOfMonth(now).toISOString()

  const [starts, cancels] = await Promise.all([
    supabase.from('membership_transitions')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .eq('kind', 'recurring_start')
      .gte('occurred_at', monthStartIso),
    supabase.from('membership_transitions')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .eq('kind', 'recurring_cancel')
      .gte('occurred_at', monthStartIso),
  ])
  const err = starts.error || cancels.error
  if (err) return { success: false, error: err.message }

  return {
    success: true,
    data: {
      recurringStartsMTD: starts.count || 0,
      recurringCancelsMTD: cancels.count || 0,
      netRecurringMTD: (starts.count || 0) - (cancels.count || 0),
    },
  }
}

// ============================================================
// Revenue churn MTD — cancels priced at their stamped (mig 480)
// price, tenure-split on the contact's joined_at. estYieldCents
// prices pre-480 rows (estimate, labelled).
// ============================================================

export async function fetchRevenueChurn(supabase, locationId, estYieldCents, now = new Date()) {
  if (!locationId) return { success: false, error: 'No location' }
  const monthStartIso = startOfMonth(now).toISOString()

  const { data, error } = await supabase
    .from('membership_transitions')
    .select('occurred_at, price_cents, billing_interval, contacts!contact_id(joined_at)')
    .eq('location_id', locationId)
    .eq('kind', 'recurring_cancel')
    .gte('occurred_at', monthStartIso)
    .order('occurred_at', { ascending: true })
    .limit(999)
  if (error) return { success: false, error: error.message }

  const summary = summariseCancels((data || []).map(r => ({
    occurred_at: r.occurred_at,
    joined_at: r.contacts?.joined_at || null,
    price_cents: r.price_cents,
    interval: r.billing_interval,
  })), estYieldCents || 0)
  return { success: true, data: summary }
}

// ============================================================
// Engagement — active member rate + visits/member/week from the
// nightly contact aggregates (glofox-attendance-refresh, 04:00).
// ============================================================

export async function fetchEngagement(supabase, locationId) {
  if (!locationId) return { success: false, error: 'No location' }
  const res = await selectAll((from, to) => supabase
    .from('contacts')
    .select('total_attended_30d')
    .eq('location_id', locationId)
    .in('glofox_membership_status', MEMBER_STATUSES)
    .order('id', { ascending: true })
    .range(from, to))
  if (res.error) return { success: false, error: res.error.message }
  return { success: true, data: computeEngagement(res.rows) }
}

// ============================================================
// The floor — fill / no-show / per-coach over the last 28 days of
// PAST classes, plus new-joiner activation. Fill numerator is
// Glofox's own frozen booked count (raw.booked — survives roster-
// assembly gaps); no-show comes from the assembled roster.
// ============================================================

export async function fetchFloor(supabase, locationId, now = new Date()) {
  if (!locationId) return { success: false, error: 'No location' }
  const nowIso = now.toISOString()
  const cut28 = daysAgoIso(28, now)
  const cut7 = daysAgoIso(7, now)
  // Activation looks back 28d of joiners + their first 14 days of
  // classes, so bookings need 28 + ACTIVATION_WINDOW_DAYS of depth.
  const cutCohort = daysAgoIso(28 + ACTIVATION_WINDOW_DAYS, now)

  // .order('id') — the unique key, so page boundaries are stable
  // (starts_at has ties of 30+ rows per class time; a tie straddling a
  // boundary double-counts or skips rows). Aggregation doesn't need
  // time order.
  const [occRes, bookRes, joinersRes] = await Promise.all([
    selectAll((from, to) => supabase
      .from('class_occurrences')
      .select('glofox_event_id, name, instructor, capacity, starts_at, raw')
      .eq('location_id', locationId)
      .gte('starts_at', cut28)
      .lte('starts_at', nowIso)
      .is('cancelled_at', null)
      .order('id', { ascending: true })
      .range(from, to)),
    selectAll((from, to) => supabase
      .from('class_bookings')
      .select('glofox_event_id, contact_id, status, attended, starts_at')
      .eq('location_id', locationId)
      .gte('starts_at', cutCohort)
      .lte('starts_at', nowIso)
      .order('id', { ascending: true })
      .range(from, to)),
    // Activation cohort = new MEMBERS (converted_at, mig 350) — not
    // every new Glofox contact, which would dilute the rate with trial
    // leads who never bought. Mapped to the joined_at key
    // computeActivation expects (the window anchors on becoming a
    // member).
    supabase
      .from('contacts')
      .select('id, converted_at')
      .eq('location_id', locationId)
      .gte('converted_at', cutCohort)
      .order('converted_at', { ascending: true })
      .limit(999),
  ])
  const err = occRes.error || bookRes.error || joinersRes.error
  if (err) return { success: false, error: err.message }

  const occurrences = occRes.rows.map(o => ({
    glofox_event_id: o.glofox_event_id,
    name: o.name,
    instructor: o.instructor,
    capacity: o.capacity,
    starts_at: o.starts_at,
    booked: Number(o.raw?.booked) || 0,
  }))
  const window28Bookings = bookRes.rows.filter(b => b.starts_at >= cut28)

  const floor = computeFloor(occurrences, window28Bookings, { sevenDayCutIso: cut7 })
  const joiners = (joinersRes.data || []).map(j => ({ id: j.id, joined_at: j.converted_at }))
  const activation = computeActivation(joiners, bookRes.rows, now.getTime())

  return {
    success: true,
    data: { ...floor, activation, noData: occurrences.length === 0 },
  }
}

// ============================================================
// Acquisition cost MTD — campaign-level ad spend over joins.
// (ad_insights_daily stores campaign+adset+ad rows per day — the
// level filter must stay in the query or spend triple-counts.)
// ============================================================

export async function fetchAdSpendMTD(supabase, locationId, now = new Date()) {
  if (!locationId) return { success: false, error: 'No location' }
  const monthStartStr = isoDate(startOfMonth(now))
  const res = await selectAll((from, to) => supabase
    .from('ad_insights_daily')
    .select('level, spend')
    .eq('location_id', locationId)
    .eq('level', 'campaign')
    .gte('date', monthStartStr)
    .order('id', { ascending: true })
    .range(from, to))
  if (res.error) return { success: false, error: res.error.message }
  let spend = 0
  for (const r of res.rows) {
    if (r.level !== 'campaign') continue
    spend += Number(r.spend) || 0
  }
  return { success: true, data: { spendMTD: spend } }
}
