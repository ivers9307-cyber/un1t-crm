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

// LEAVEPHONE.1 — the caller's OWN holiday allowance. No profile_id on purpose:
// GET /api/schedule/allowances defaults it to the caller, and a coach may read
// nobody else's. The response carries `not_applicable: true` for a contractor.
export function getMyAllowance({ year, locationId }) {
  const qs = new URLSearchParams()
  if (year) qs.set('year', String(year))
  return api(`/api/schedule/allowances?${qs.toString()}`, { locationId })
}

// LEAVEPHONE.1 — ask the SERVER what this request would cost and which of MY
// published shifts it hits. The phone never counts days itself: a holiday's
// cost depends on bank holidays and studio closures only the server can see.
// location_id is the studio createTimeOffRequest will file at, so the answer
// is about the same studio. The route ignores profile_id in preview mode, so
// none is sent. Read the answer with leavePreviewFrom (lib/leave-form.js),
// which also recognises an older deployment answering with the request list.
export function getLeavePreview({ type, startDate, endDate, locationId }) {
  const qs = new URLSearchParams()
  qs.set('preview', '1')
  qs.set('type', type)
  qs.set('start_date', startDate)
  qs.set('end_date', endDate || startDate)
  if (locationId) qs.set('location_id', locationId)
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

// SWAPOVERRIDE.1 — `confirmConflicts` re-sends an approval the route refused
// with 409 swap_conflicts (leave / same-day clash) as confirm_conflicts: true,
// the manager's "Approve anyway". Only sent when set, so every other call's
// body is unchanged.
export function respondToSwap(id, status, reviewNote, locationId, { confirmConflicts = false } = {}) {
  const body = { status, review_note: reviewNote || null }
  if (confirmConflicts) body.confirm_conflicts = true
  return api(`/api/schedule/swaps/${id}`, {
    method: 'PUT',
    locationId,
    body,
  })
}

// CT-P3b — swaps targeted at / claimed by the caller (for_me=1). Each row
// carries the requester NAME + shift via the service-role profiles embed, so
// the actionable "Swaps offered to you" list works on mobile (the authenticated
// client can't embed profiles itself).
export function getSwapsForMe({ locationId }) {
  const qs = new URLSearchParams()
  if (locationId) qs.set('location_id', locationId)
  qs.set('for_me', '1')
  return api(`/api/schedule/swaps?${qs.toString()}`, { locationId })
}

// CT-P3b — the open swap pool the caller may claim (open=1): unclaimed,
// pending, not their own. Same name-bearing service-role shape.
export function getOpenSwaps({ locationId }) {
  const qs = new URLSearchParams()
  if (locationId) qs.set('location_id', locationId)
  qs.set('open', '1')
  return api(`/api/schedule/swaps?${qs.toString()}`, { locationId })
}

/**
 * Set / clear / change a partial-shift override on an assignment
 * (mig 099/100). Pass null to any time field to clear that override
 * back to the block default. partial_reason is optional free text
 * (200 char cap server-side).
 *
 * ROSTER-FIX.3 (D3) — MANAGER-ONLY. The route 403s a coach, including one
 * editing their own shift: a coach is paid for a window a manager set. Every
 * caller of this must already be behind a manager gate (Manage mode, and the
 * Schedule tab's canAdjustShiftTimes).
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
// assigned coaches (names via the service-role route).
// ROSTER-FIX.2 — this comment used to claim the route was MANAGER_ROLES-gated;
// it never was, and it is not now. The route is open to any authenticated user
// at the location, but a non-manager gets PUBLISHED blocks only (D1) in a slim
// shape with no capacity, no notes and no cancelled assignments. Manage mode
// is a manager surface, so this caller still sees the full shape.
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

// Remove a coach from a shift (delete the assignment). ROSTER-FIX.3 (D2) —
// MANAGER-ONLY: a coach who cannot work a shift posts a swap instead.
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

// LEAVE.1 — after approving leave that left the person rostered: take them off
// exactly the shifts the approver was shown (the approve response's
// `clashes`). Same server path as a manager removing a coach by hand, so the
// coach is notified and the change is logged.
export function unassignLeaveClashes(id, { assignmentIds, locationId }) {
  return api(`/api/schedule/time-off/${id}/unassign-clashes`, {
    method: 'POST',
    locationId,
    body: { assignment_ids: assignmentIds },
  })
}

// Assignable staff at the active location (id + full_name + active + locations).
// ROSTER-FIX.2 — `fields=picker` pins the pay-free shape; the plain
// /api/staff list hands an admin caller every HR column to build a dropdown.
export function getLocationStaff({ locationId }) {
  return api('/api/staff?fields=picker', { locationId })
}
