// Mobile race-day control client. Trackside start / finish / reset of
// runners, mirroring the web RaceControlPanel. Goes through api() so the
// Bearer + x-impersonate-target + x-active-location headers are built once
// and can't drift.
//
// Entry point is GET /api/races (MANAGER_ROLES + races feature) — the mobile
// `races` permission defaults to manager+ to match. The board + the action
// routes need only the races feature, which they re-check server-side.
import { api } from './api'

/** GET /api/races?location_id= → { success, data: races[] } (race_date desc) */
export async function listRaces({ locationId } = {}) {
  const qs = locationId ? `?location_id=${encodeURIComponent(locationId)}` : ''
  return api(`/api/races${qs}`, { locationId })
}

/** GET /api/events/[id]/control-board → { success, race:{...,waves}, registrations } */
export async function getControlBoard(eventId, { locationId } = {}) {
  return api(`/api/events/${eventId}/control-board`, { locationId })
}

/**
 * POST /api/registrations/[id]/race-{start,finish,reset}
 * @param {string} action 'race-start' | 'race-finish' | 'race-reset'
 */
export async function raceAction(registrationId, action, { locationId } = {}) {
  return api(`/api/registrations/${registrationId}/${action}`, { method: 'POST', locationId })
}

// ── Pure presentation helpers ──────────────────────────────────────

export function raceDateLabel(iso) {
  if (!iso) return ''
  try {
    return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
  } catch {
    return iso
  }
}
