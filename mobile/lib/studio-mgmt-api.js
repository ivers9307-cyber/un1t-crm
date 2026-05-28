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

// ── Air conditioning (Sensibo) — legacy single-device routes ──────
// Still used by the existing AcCard on (tabs)/studio.jsx. After
// STUDIO-AC-DEVICES.2 these now shim through the dispatcher on the
// server, so sessions get a populated device_id and the auto-off
// cron picks them up correctly.

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

// ── Air conditioning — device-scoped routes (MOBILE-AC.1) ─────────
// New surface for the multi-device AC list screen at /ac. The list
// endpoint is already allowlist-filtered server-side by the
// caller's profile_locations.ac_device_ids, so the client just
// renders whatever comes back — no separate per-device permission
// check on the mobile side.

export function listAcDevices(locationId) {
  return api('/api/studio-management/ac/devices', { locationId })
}

export function getAcDevice(deviceId, locationId) {
  return api(`/api/studio-management/ac/devices/${deviceId}`, { locationId })
}

export function turnOnAcDevice(deviceId, locationId) {
  return api(`/api/studio-management/ac/devices/${deviceId}/turn-on`, {
    method: 'POST',
    locationId,
  })
}

export function turnOffAcDevice(deviceId, locationId) {
  return api(`/api/studio-management/ac/devices/${deviceId}/turn-off`, {
    method: 'POST',
    locationId,
  })
}

export function extendAcDevice(deviceId, locationId) {
  return api(`/api/studio-management/ac/devices/${deviceId}/extend`, {
    method: 'POST',
    locationId,
  })
}
