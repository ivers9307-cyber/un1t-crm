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
async function pendingList(path, locationId) {
  const qs = new URLSearchParams({ location_id: locationId, status: 'pending' })
  try {
    const res = await api(`${path}?${qs.toString()}`, { locationId })
    return res?.success && Array.isArray(res.data) ? res.data : null
  } catch {
    return null
  }
}

export async function fetchStudioDashboard(locationId) {
  const [base, pendingTimeOff, pendingSwaps] = await Promise.all([
    fetchStudioDashboardData(supabase, locationId),
    // Manager scope (incl. LEAVE.2's "leave taken by anyone who belongs
    // here") and the expired-pending cut are the route's, not ours.
    pendingList('/api/schedule/time-off', locationId),
    pendingList('/api/schedule/swaps', locationId),
  ])
  if (!base.success) return base
  return { ...base, data: { ...base.data, pendingTimeOff, pendingSwaps } }
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
