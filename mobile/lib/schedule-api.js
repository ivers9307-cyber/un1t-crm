// Mobile-side schedule API helpers. Calls the existing /api/schedule/*
// routes on the CRM with the active-location header for scoping.

import { api } from './api'

export function getMyShifts({ locationId, profileId, startDate, endDate }) {
  const qs = new URLSearchParams()
  if (locationId) qs.set('location_id', locationId)
  if (profileId) qs.set('profile_id', profileId)
  if (startDate) qs.set('start_date', startDate)
  if (endDate) qs.set('end_date', endDate)
  return api(`/api/schedule/shifts?${qs.toString()}`, { locationId })
}

export function getTeamShifts({ locationId, startDate, endDate }) {
  // Same route as getMyShifts but WITHOUT profile_id → the whole location's
  // roster for the date range. GET /api/schedule/shifts is service-role and
  // already embeds profiles(full_name, role, avatar_url) per shift, so the
  // names come back without a mobile-direct profiles embed (the authenticated
  // client can't SELECT profiles — see CLAUDE.md "Lessons learned").
  const qs = new URLSearchParams()
  if (locationId) qs.set('location_id', locationId)
  if (startDate) qs.set('start_date', startDate)
  if (endDate) qs.set('end_date', endDate)
  return api(`/api/schedule/shifts?${qs.toString()}`, { locationId })
}

export function getMyTimeOff({ locationId, profileId, status }) {
  const qs = new URLSearchParams()
  if (locationId) qs.set('location_id', locationId)
  if (profileId) qs.set('profile_id', profileId)
  if (status) qs.set('status', status)
  return api(`/api/schedule/time-off?${qs.toString()}`, { locationId })
}

export function createTimeOffRequest({ type, startDate, endDate, reason, locationId }) {
  return api('/api/schedule/time-off', {
    method: 'POST',
    locationId,
    body: {
      type,
      start_date: startDate,
      end_date: endDate,
      reason: reason || null,
      location_id: locationId,
    },
  })
}

export function cancelTimeOffRequest(id, locationId) {
  return api(`/api/schedule/time-off/${id}`, {
    method: 'PUT',
    locationId,
    body: { status: 'cancelled' },
  })
}

export function cancelSwapRequest(id, locationId) {
  return api(`/api/schedule/swaps/${id}`, {
    method: 'PUT',
    locationId,
    body: { status: 'cancelled' },
  })
}

export function createSwapRequest({ requesterShiftId, targetShiftId, targetId, reason, locationId }) {
  return api('/api/schedule/swaps', {
    method: 'POST',
    locationId,
    body: {
      requester_shift_id: requesterShiftId,
      target_shift_id: targetShiftId || null,
      target_id: targetId || null,
      reason: reason || null,
    },
  })
}

export function respondToSwap(id, status, reviewNote, locationId) {
  return api(`/api/schedule/swaps/${id}`, {
    method: 'PUT',
    locationId,
    body: { status, review_note: reviewNote || null },
  })
}

/**
 * Set / clear / change a partial-shift override on an assignment
 * (mig 099/100). Pass null to any time field to clear that override
 * back to the block default. partial_reason is optional free text
 * (200 char cap server-side).
 */
export function adjustShiftAssignment(assignmentId, { startTime, endTime, reason, locationId }) {
  return api(`/api/schedule/assignments/${assignmentId}`, {
    method: 'PUT',
    locationId,
    body: {
      start_time_override: startTime ?? null,
      end_time_override: endTime ?? null,
      partial_reason: reason ?? null,
    },
  })
}

// --- Manager "Manage" mode (MOBILE-SCHED-EDIT) ---------------------------

// All shift blocks for the location/week, incl. empty ones, with capacity +
// assigned coaches (names via the service-role route). MANAGER_ROLES-gated.
export function getScheduleBlocks({ locationId, startDate, endDate }) {
  const qs = new URLSearchParams()
  if (locationId) qs.set('location_id', locationId)
  if (startDate) qs.set('start_date', startDate)
  if (endDate) qs.set('end_date', endDate)
  return api(`/api/schedule/blocks?${qs.toString()}`, { locationId })
}

// Assign one coach to a block. On 409 "at capacity", the caller re-invokes
// with allowOverCapacity:true. Response may carry warnings[] (advisories).
export function assignCoachToBlock(blockId, { profileId, allowOverCapacity, locationId }) {
  return api(`/api/schedule/blocks/${blockId}/assignments`, {
    method: 'POST',
    locationId,
    body: { profile_id: profileId, allow_over_capacity: allowOverCapacity || undefined },
  })
}

// Remove a coach from a shift (delete the assignment).
export function removeAssignment(assignmentId, { locationId }) {
  return api(`/api/schedule/assignments/${assignmentId}`, { method: 'DELETE', locationId })
}

// Approve / reject a time-off request (MANAGER_ROLES).
export function respondToTimeOff(id, status, reviewNote, locationId) {
  return api(`/api/schedule/time-off/${id}`, {
    method: 'PUT',
    locationId,
    body: { status, review_note: reviewNote || null },
  })
}

// Assignable staff at the active location (id + full_name + active + locations).
export function getLocationStaff({ locationId }) {
  return api('/api/staff', { locationId })
}
