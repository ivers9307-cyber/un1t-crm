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

export function getOpenSwaps({ locationId }) {
  const qs = new URLSearchParams()
  if (locationId) qs.set('location_id', locationId)
  qs.set('status', 'pending')
  return api(`/api/schedule/swaps?${qs.toString()}`, { locationId })
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
