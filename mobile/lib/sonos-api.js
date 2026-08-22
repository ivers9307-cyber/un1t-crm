// mobile/lib/sonos-api.js
// SONOSMOB.3 — mobile wire layer for the Sonos live-control screen.
//
// Four calls, all onto routes the web control strip already uses. Every one
// goes through api() so authHeaders() carries the Bearer token,
// x-active-location AND x-impersonate-target — a hand-rolled header drops
// the last one and "View as user" silently runs as the real master.
//
// Those routes are service-role (no RLS) and gate on the top-level
// `device_control` key — cross-platform since SONOSMOB.2, so the screen
// gates on the same key via canMobile and the UI never offers something
// the server refuses.
//
// Soft failures come back as success: true with live: false / connected:
// false + a `reason` (now-playing, household). Branch on those fields, not
// on .success alone. Control failures carry `code`, and on a multi-group
// schedule `applied` / `failedGroups` — volume_up/down are RELATIVE, so a
// partial failure must never be blindly retried.

import { api } from './api'

export function listSonosSchedules(locationId) {
  return api('/api/sonos/schedules', { locationId })
}

// Favourites live on the household response: { connected, reachable,
// favorites: [{ id, name }], favoritesFailed? }.
export function getSonosHousehold(locationId) {
  return api('/api/sonos/household', { locationId })
}

export function getSonosNowPlaying(scheduleId, locationId) {
  return api(`/api/sonos/now-playing?schedule_id=${encodeURIComponent(scheduleId)}`, { locationId })
}

// `value` is omitted from the body when undefined. The route's Zod schema
// makes it optional; a null would fail z.union([number, string]).
export function sendSonosAction(scheduleId, action, value, locationId) {
  const body = { schedule_id: scheduleId, action }
  if (value !== undefined) body.value = value
  return api('/api/sonos/control', { method: 'POST', locationId, body })
}
