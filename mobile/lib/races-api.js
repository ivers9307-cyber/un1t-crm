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

/**
 * GET /api/races/today?location_id= → { success, data: races[] }
 *
 * RACE-TAB.1 — races RUNNING TODAY at one studio, newest-first-irrelevant:
 * the array comes back in running order, empty when there is no race. Used
 * by (tabs)/_layout.jsx to decide whether to surface a contextual Race tab,
 * and by (tabs)/race.jsx to pick which board to show.
 *
 * Deliberately NOT listRaces() + a client-side date filter: "today" is a
 * Europe/Dublin boundary and the route computes it server-side, so a phone
 * on holiday time or a tablet stuck on UTC cannot disagree with the person
 * standing next to it about what day the studio is having. It is also a far
 * smaller payload — listRaces embeds every wave and every registration for
 * every race the studio has ever run.
 */
export async function listTodaysRaces({ locationId } = {}) {
  const qs = locationId ? `?location_id=${encodeURIComponent(locationId)}` : ''
  return api(`/api/races/today${qs}`, { locationId })
}

/** GET /api/events/[id]/control-board → { success, race:{...,waves}, registrations } */
export async function getControlBoard(eventId, { locationId } = {}) {
  return api(`/api/events/${eventId}/control-board`, { locationId })
}

/**
 * POST /api/registrations/[id]/race-{start,finish,reset}
 *
 * @param {string} registrationId
 * @param {string} action  'race-start' | 'race-finish' | 'race-reset'
 * @param {object} [opts]
 * @param {string} [opts.locationId] x-active-location override for this call
 * @param {boolean} [opts.override]  a NOTE, not a bypass. It records that the
 *   operator reached this button through the board's offsite unlock — their
 *   phone placed them away from the studio and they tapped "I'm at the gym".
 *   The routes only LOG it (logWarn 'race-control' / 'offsite override');
 *   they run no position check, so sending it changes nothing about what is
 *   allowed and omitting it withholds no permission. Do not grow a
 *   server-side guard out of this flag — a client-asserted position is not
 *   something to gate writes on, and the decision to keep the boundary at
 *   the races-permission + location checks is deliberate.
 *   The key is sent ONLY when truthy: an explicit `override: false` on every
 *   ordinary start/finish would turn a rare, deliberate signal into
 *   background noise in the one log where it needs to stand out.
 */
export async function raceAction(registrationId, action, { locationId, override } = {}) {
  return api(`/api/registrations/${registrationId}/${action}`, {
    method: 'POST',
    locationId,
    ...(override ? { body: { override: true } } : {}),
  })
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
