// mobile/lib/sonos-api.js
// SONOSMOB.3 / SONOSGRP.4 — mobile wire layer for the Sonos live-control
// screen.
//
// Four calls, all onto routes the web control strip already uses. Every one
// goes through api() so authHeaders() carries the Bearer token,
// x-active-location AND x-impersonate-target — a hand-rolled header drops
// the last one and "View as user" silently runs as the real master.
//
// Dual addressing (SONOSGRP.4): now-playing and control take a `target` of
// { scheduleId } or { groupId } — a sonos_schedules row, or a raw (ephemeral)
// Sonos group id from the household response. The wrapper stays dumb: it
// builds `schedule_id`/`group_id` from whichever key is present (preferring
// scheduleId if a confused caller passes both) and the SERVER enforces
// exactly-one, answering 400 otherwise. A stale group id soft-fails as
// reason/code `regrouped`.
//
// Those routes are service-role (no RLS) and gate on the top-level
// `device_control` key — cross-platform since SONOSMOB.2, so the screen
// gates on the same key via canMobile and the UI never offers something
// the server refuses.
//
// Soft failures come back as success: true with live: false / connected:
// false + a `reason` (now-playing, household). Branch on those fields, not
// on .success alone. Control failures carry `code`, plus `applied` /
// `failedGroups` (only meaningful when a schedule spans more than one
// group) — volume_up/down are RELATIVE, so a partial failure must never be
// blindly retried.

import { api } from './api'

// Returns { success, schedules } — the list is on `schedules`, not `data`.
export function listSonosSchedules(locationId) {
  return api('/api/sonos/schedules', { locationId })
}

// Favourites live on the household response: { connected, reachable,
// favorites: [{ id, name }], favoritesFailed? }.
export function getSonosHousehold(locationId) {
  return api('/api/sonos/household', { locationId })
}

// `target` is { scheduleId } or { groupId } — see the header.
export function getSonosNowPlaying(target, locationId) {
  const query = target.scheduleId
    ? `schedule_id=${encodeURIComponent(target.scheduleId)}`
    : `group_id=${encodeURIComponent(target.groupId)}`
  return api(`/api/sonos/now-playing?${query}`, { locationId })
}

// `target` is { scheduleId } or { groupId } — see the header.
// `value` is omitted from the body when undefined. The route's Zod schema
// makes it optional; a null would fail z.union([number, string]).
export function sendSonosAction(target, action, value, locationId) {
  const body = target.scheduleId
    ? { schedule_id: target.scheduleId, action }
    : { group_id: target.groupId, action }
  if (value !== undefined) body.value = value
  return api('/api/sonos/control', { method: 'POST', locationId, body })
}
