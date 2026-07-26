// Mobile-side wrapper around the dashboard data sources. Keeps the
// import path stable for callers (mobile components import from
// '../lib/dashboard-api').
//
// Personal + Studio go direct to Supabase via the shared fetchers
// (RLS-scoped reads). Business goes through /api/dashboard/business
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

export function fetchStudioDashboard(locationId) {
  return fetchStudioDashboardData(supabase, locationId)
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
