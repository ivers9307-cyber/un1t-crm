// mobile/lib/availability-api.js
//
// AVAIL.2 — the phone's calls to /api/schedule/availability (AVAIL.1a). Own
// file rather than schedule-api.js, whose test pins its export list and which
// other scheduler PRs extend in parallel.
//
// Both go through api(): the Bearer token AND x-impersonate-target, so "View
// as user" reads and saves the viewed person's availability (the route pins
// every read and write to user.id and records the master as the actor). No
// locationId: availability is per person, not per studio.

import { api } from './api'

/** The caller's own { weekly, dated } (dated rules that ended are not returned). */
export function getMyAvailability() {
  return api('/api/schedule/availability')
}

/**
 * Replace the caller's weekly rules and not-yet-ended dated rules. `body` is
 * availability-form.js buildSaveBody().body: { weekly, dated } in canonical
 * order. Resolves api()'s envelope as is; read it with saveOutcome().
 */
export function saveMyAvailability(body) {
  return api('/api/schedule/availability', { method: 'PUT', body })
}
