// Mobile-side studio management API. Wraps the same /api/studio-
// management/* routes the web Studio Management page uses.
//
// Auth + active-location header come from the api() wrapper; the
// server uses the active location to scope UniFi + Sensibo lookups
// to that studio.

import { api } from './api'

// ── Doors (UniFi Access) ──────────────────────────────────────────

export function listDoors(locationId) {
  return api('/api/studio-management/doors', { locationId })
}

export function unlockDoor(doorId, locationId) {
  return api('/api/studio-management/unlock', {
    method: 'POST',
    locationId,
    body: { door_id: doorId },
  })
}

// ── Air conditioning (Sensibo) ────────────────────────────────────

export function getAcState(locationId) {
  return api('/api/studio-management/ac/state', { locationId })
}

export function turnAcOn(locationId) {
  return api('/api/studio-management/ac/turn-on', {
    method: 'POST',
    locationId,
  })
}

export function turnAcOff(locationId) {
  return api('/api/studio-management/ac/turn-off', {
    method: 'POST',
    locationId,
  })
}
