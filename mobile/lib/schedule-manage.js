// Pure helpers for the Schedule tab's manager "Manage" mode. No React/Supabase
// — pure functions over the /api/schedule/blocks shape (a shift_block with
// shift_assignments[] each embedding profiles) and the /api/staff shape.
// Lives in mobile/lib so the root vitest picks it up (config includes mobile/lib/**).

import { futureBlockStaffing } from 'shared/roster-staffing'
import { effectiveShiftStart, effectiveShiftEnd } from 'shared/roster-month'

// MOBILESCHED.2 — "this assignment still puts a coach on the block". Only
// `cancelled` is dead (a swap-drop tombstone, ROSTER-FIX.1 D4); `swapped` is a
// real shift, and a missing status is a legacy live row. Same rule as
// isLiveAssignment (src/lib/roster.js). The manager /api/schedule/blocks shape
// carries cancelled rows, so every count and list on the Manage card reads
// through this.
export function liveBlockAssignments(block) {
  return (Array.isArray(block?.shift_assignments) ? block.shift_assignments : [])
    .filter((a) => a?.status !== 'cancelled')
}

// Fill state of a block for the Manage card's chip.
//
//   'empty' / 'short' — shared/roster-staffing's answer, the SAME one the web
//                       calendar gives (live coaches vs min_coaches; an empty
//                       block is flagged whatever the minimum; a past block is
//                       history and never flagged).
//   'over'            — more live coaches than max_coaches (capacity, any date).
//   'ok'              — otherwise.
//
// Was a local count of every assignment row, cancelled included, so a shift
// with a dropped coach read fuller than it was, and "nobody on it" and "1 of 2"
// were one amber 'under' state.
//
// @returns {{ state: 'empty'|'short'|'over'|'ok', count: number, min: number, max: number|null, label: string }}
export function blockFillState(block, todayIso) {
  const count = liveBlockAssignments(block).length
  const min = Number(block?.min_coaches) || 0
  const max = block?.max_coaches ?? null
  const staffing = futureBlockStaffing(block, todayIso)
  let state = 'ok'
  if (staffing && staffing.status !== 'ok') state = staffing.status
  else if (max != null && count > max) state = 'over'
  let label
  if (state === 'empty') label = 'No coach'
  else if (state === 'short') label = `${count} of ${min}`
  else label = `${count}/${max ?? '—'}`
  return { state, count, min, max, label }
}

// MOBILESCHED.2 — the shift-like row Manage mode hands the screen's
// AdjustSheet. AdjustSheet measures an edit against `block_start_time` /
// `block_end_time` (the /shifts row's keys) and saves `null` = "inherit the
// block" when the edit equals them. This used to pass the block's times as
// `start_time`/`end_time`, which AdjustSheet never reads, so from Manage mode
// the sheet opened at the TEMPLATE's hours and compared against them: on a
// block edited away from its template, opening Adjust showed the wrong window
// and saving an unchanged time wrote a spurious override. The template is
// still the fallback when a block carries no time of its own.
export function adjustTargetFor(block, assignment) {
  return {
    shift_assignment_id: assignment?.id,
    shift_date: block?.block_date,
    block_start_time: block?.start_time ?? null,
    block_end_time: block?.end_time ?? null,
    shift_templates: block?.shift_templates,
    start_time_override: assignment?.start_time_override ?? null,
    end_time_override: assignment?.end_time_override ?? null,
    partial_reason: assignment?.partial_reason ?? null,
  }
}

// MOBILESCHED.2 — one coach's working window on a block card: their override
// on top of the BLOCK's time, the template last. The assignment row carries no
// block time of its own, so resolving it alone fell straight through to the
// template — a coach with only a start override showed the template's end.
export function assignmentWindow(block, assignment) {
  const row = adjustTargetFor(block, assignment)
  return { start: effectiveShiftStart(row), end: effectiveShiftEnd(row) }
}

// Coaches assignable to a block: active staff who belong to `locationId` and
// aren't already on the block, sorted by name. `staff` is the /api/staff data
// array (each { id, full_name, active, profile_locations:[{ location_id }] }).
export function filterAssignableCoaches(staff, block, locationId) {
  // Live rows only: a cancelled tombstone does not hold the seat, and the
  // assign route clears it and re-adds that coach (ROSTER-FIX.1 D4).
  const assigned = new Set(liveBlockAssignments(block).map((a) => a.profile_id))
  return (Array.isArray(staff) ? staff : [])
    .filter((s) => {
      if (!s || s.active === false) return false
      if (assigned.has(s.id)) return false
      return (s.profile_locations || []).some((pl) => pl.location_id === locationId)
    })
    .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''))
}

// Manager roles, mirrored from src/lib/schemas.js MANAGER_ROLES. Defined here
// rather than imported because the mobile bundle can't reach that web-side
// module and shared/permissions.js does not export it.
export const MANAGER_ROLES = ['master', 'owner', 'manager', 'head_coach']

// RUNWAY.1 — the schedule tab's ?view= deep-link param (set by
// lib/notification-nav.js for roster_runway pushes and by the Studio
// dashboard's runway chip). Only 'manage' is honoured, and only for a manager
// role: a coach who is handed the link lands on their own week. null = leave
// the view alone.
export function scheduleViewFromParam(viewParam, role) {
  return viewParam === 'manage' && MANAGER_ROLES.includes(role) ? 'manage' : null
}

// ROSTER-FIX.3 (D3) — who may move a shift's paid window. Richard's call
// (2026-09-09): a coach is paid for a window a manager set, so owning the
// shift buys you nothing here — only a manager role does. This mirrors the
// gate on PUT /api/schedule/assignments/[id]; keep the two in step, or the
// UI offers an edit the route will 403.
export function canAdjustShiftTimes(profile, shift) {
  if (!shift?.shift_assignment_id) return false
  return MANAGER_ROLES.includes(profile?.role)
}

// ROSTER-FIX.7 — may this person withdraw this leave request? Mirrors the self
// branch of PUT /api/schedule/time-off/[id], which accepts a self-cancel only
// while the row is still `pending`; keep the two in step or the UI offers a
// button the route refuses. Deliberately id-matched rather than trusting the
// caller's filter: the Schedule tab's Me view fetches only the user's own
// rows today, but the Team view shares the same renderer.
export function canCancelTimeOff(row, profile) {
  if (row?.status !== 'pending') return false
  if (!row?.profile_id || !profile?.id) return false
  return row.profile_id === profile.id
}
