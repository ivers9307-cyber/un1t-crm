// Mobile-side wrapper around the shared dashboard fetchers. Keeps
// the import path stable for callers (mobile components import from
// '../lib/dashboard-api') while the actual SQL lives in
// shared/dashboard-data.js so the web pages can use it too.

import { supabase } from './supabase'
import {
  fetchPersonalDashboardData,
  fetchStudioDashboardData,
  fetchBusinessDashboardData,
} from '../../shared/dashboard-data'

export function fetchPersonalDashboard(profileId, locationId) {
  return fetchPersonalDashboardData(supabase, profileId, locationId)
}

export function fetchStudioDashboard(locationId) {
  return fetchStudioDashboardData(supabase, locationId)
}

export function fetchBusinessDashboard(locationId) {
  return fetchBusinessDashboardData(supabase, locationId)
}
