// Mobile-side wrapper around the dashboard data sources. Keeps the
// import path stable for callers (mobile components import from
// '../lib/dashboard-api').
//
// Personal + Studio go direct to Supabase via the shared fetchers
// (RLS-scoped reads) — except Studio's pending time-off + swap lists,
// which need names from `profiles` and so come from the service-role
// /api/schedule routes (STUDIODASH.1, see fetchStudioDashboard). Business goes through /api/dashboard/business
// (DASH-M.1) — the command-centre payload is a heavy server-side
// composition (approvals registry fan-out, radar scoring, paginated
// invoice sums) and its gating lives server-side; api() attaches auth
// + x-active-location + the impersonation header (never hand-roll a
// Bearer header — the #382 lesson).

import { supabase } from './supabase'
import { api } from './api'
import {
  fetchPersonalDashboardData,
  fetchStudioDashboardData,
} from 'shared/dashboard-data'

export function fetchPersonalDashboard(profileId, locationId) {
  return fetchPersonalDashboardData(supabase, profileId, locationId)
}

// A list the route could not return is `null`, never `[]`: the old direct
// read embedded profiles, 500'd on every call, and `|| []` showed managers
// "Nothing waiting on you." for months. The screen renders null as an error.
async function pendingList(path, locationId, status = 'pending') {
  const qs = new URLSearchParams({ location_id: locationId, status })
  try {
    const res = await api(`${path}?${qs.toString()}`, { locationId })
    return res?.success && Array.isArray(res.data) ? res.data : null
  } catch {
    return null
  }
}

// STUDIODASH.2 — the manager's swap queue is the web approvals provider's
// (src/lib/approvals/providers/shift-swaps.js): `pending` (open/targeted, or a
// drop a manager can approve directly) AND `awaiting_approval` (a coach
// claimed it). The route filters on one status, so one call each. Either
// failing makes the list null: half a queue would hide approvals.
async function swapQueue(locationId) {
  const [open, claimed] = await Promise.all([
    pendingList('/api/schedule/swaps', locationId, 'pending'),
    pendingList('/api/schedule/swaps', locationId, 'awaiting_approval'),
  ])
  if (!open || !claimed) return null
  return [...open, ...claimed].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
}

// Row title, worded like the web approvals queue.
export function swapRowTitle(swap) {
  const requester = swap?.requester?.full_name || 'Coach'
  const target = swap?.target?.full_name
  const base = target ? `${requester} ↔ ${target}` : `${requester} (drop)`
  return swap?.status === 'awaiting_approval' ? `${base} — claimed` : base
}

// RUNWAY.1 — the roster runway for this studio (shared/roster-runway.js shape)
// or null. null means "no chip": every week is ready, the caller is not a
// manager here (the route 403s), the read failed, or the route is not deployed
// yet (the OTA can land before the web deploy: an HTML 404, which api() turns
// into a { success: false } envelope). Unlike the two pending
// lists above, hiding on failure is right: this is an alert, the daily push is
// its primary channel, and a chip must never claim a problem it could not read.
export async function fetchRosterRunway(locationId) {
  const qs = new URLSearchParams({ location_id: locationId })
  try {
    const res = await api(`/api/schedule/runway?${qs.toString()}`, { locationId })
    return res?.success ? (res.data?.runway ?? null) : null
  } catch {
    return null
  }
}

export async function fetchStudioDashboard(locationId) {
  const [base, pendingTimeOff, pendingSwaps, rosterRunway] = await Promise.all([
    fetchStudioDashboardData(supabase, locationId),
    // Manager scope (incl. LEAVE.2's "leave taken by anyone who belongs
    // here") and the expired-pending cut are the route's, not ours.
    pendingList('/api/schedule/time-off', locationId),
    swapQueue(locationId),
    fetchRosterRunway(locationId),
  ])
  if (!base.success) return base
  return { ...base, data: { ...base.data, pendingTimeOff, pendingSwaps, rosterRunway } }
}

/**
 * Fetch every block of the Business command centre for the active
 * location. Resolves to the standard { success, data?, error? }
 * envelope; on success, data is { locationName, kpis, funnel, ads,
 * membership, today, rail } with null for any block that failed
 * server-side (the screen renders a compact error cell per null).
 *
 * @param {object} [opts]
 * @param {string} [opts.locationId] override the active location
 */
export function fetchBusinessCommandCentre({ locationId } = {}) {
  return api('/api/dashboard/business', { locationId })
}
