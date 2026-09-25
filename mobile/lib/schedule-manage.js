// Pure helpers for the Schedule tab's manager "Manage" mode. No React/Supabase
// — pure functions over the /api/schedule/blocks shape (a shift_block with
// shift_assignments[] each embedding profiles) and the /api/staff shape.
// Lives in mobile/lib so the root vitest picks it up (config includes mobile/lib/**).

import { futureBlockStaffing } from 'shared/roster-staffing'
import { isAdminShift } from 'shared/shift-kind'
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
//   'admin'           — SHIFTTYPE.1: an admin shift has no minimum staffing, so
//                       it is never 'empty' or 'short'. Capacity still applies:
//                       over max is 'over'.
//   'ok'              — otherwise.
//
// Was a local count of every assignment row, cancelled included, so a shift
// with a dropped coach read fuller than it was, and "nobody on it" and "1 of 2"
// were one amber 'under' state.
//
// @returns {{ state: 'empty'|'short'|'over'|'admin'|'ok', count: number, min: number, max: number|null, label: string }}
export function blockFillState(block, todayIso) {
  if (isAdminShift(block)) {
    const count = liveBlockAssignments(block).length
    const max = block?.max_coaches ?? null
    if (max != null && count > max) return { state: 'over', count, min: 0, max, label: `${count}/${max}` }
    return { state: 'admin', count, min: 0, max, label: 'Admin' }
  }
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

// SHIFTTYPE.1 — the line under an empty block. An admin shift has no minimum,
// so it says what the web card says ("Nobody assigned"); a class block keeps
// its wording.
export function emptyBlockText(block) {
  return isAdminShift(block) ? 'Nobody assigned' : 'No one assigned yet.'
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

// MANAGEMODE.1 — Manage mode's roster load, decided here so it can be tested
// (there is no React Native component runner). The web calendar learnt these
// rules in ROSTER-FIX.6a / 6a-9 / ROSTERLOAD.1 (src/components/schedule/
// useScheduleData.js); the phone blanked the roster on ANY failed load,
// including a background refresh of the week already on screen.
//
//   success                        → replace, remember what it was loaded for
//   fail, SAME location+week       → keep what is on screen, say it is stale
//   fail, different location/week  → clear: the old week's blocks under the
//                                    new week's dates read as "nobody is
//                                    rostered", and a manager acts on it
//   401                            → today's handling, unchanged: clear and
//                                    show the server's words, no Retry (a
//                                    retry of a dead session fails the same
//                                    way). Deliberately NOT the web's rule,
//                                    which keeps a same-week roster on a 401.
//
// `blocks: undefined` means "leave state alone". Request ORDERING (a slow
// older answer landing after a newer one) is the caller's generation counter;
// this only judges an answer that is still current.

/** What a loaded roster belongs to: location AND week. */
export function rosterKey(locationId, weekStart, weekEnd) {
  return `${locationId}|${weekStart}..${weekEnd}`
}

export const ROSTER_LOAD_FAILED = 'Failed to load roster'

/**
 * @param {{ res: any, requestedKey: string, loadedKey: string|null }} args
 * @returns {{ blocks?: any[], loadedKey: string|null, error: string|null, stale: boolean, canRetry: boolean }}
 */
export function rosterLoadOutcome({ res, requestedKey, loadedKey }) {
  if (res?.success) {
    const data = res.data
    if (data == null) return { blocks: [], loadedKey: requestedKey, error: null, stale: false, canRetry: false }
    if (Array.isArray(data)) return { blocks: data, loadedKey: requestedKey, error: null, stale: false, canRetry: false }
    res = { success: false, error: 'The server sent an answer this screen could not read.' }
  }
  const reason = res?.error || ROSTER_LOAD_FAILED
  if (res?.status === 401) return { blocks: [], loadedKey: null, error: reason, stale: false, canRetry: false }
  if (loadedKey !== null && loadedKey === requestedKey) {
    return { loadedKey, error: reason, stale: true, canRetry: true }
  }
  return { blocks: [], loadedKey: null, error: `The roster could not be loaded. ${reason}`, stale: false, canRetry: true }
}

// MANAGEMODE.1 (review) — may a load write state? Two independent reasons it
// may not, and the generation counter alone only covers the first:
//   - a NEWER load started since (gen !== currentGen), or
//   - it asked for a location+week the screen has since LEFT. An assign or
//     remove calls load() from the render it started in; if the manager
//     paged weeks or switched studio while it was in flight, that load
//     fetches the old key, and being the newest it would beat the correct
//     one and paint studio A's roster under studio B. The caller checks this
//     BEFORE bumping the generation too, so such a load never starts.
export function isCurrentLoad({ gen, currentGen, requestedKey, currentKey }) {
  return gen === currentGen && requestedKey === currentKey
}

// MANAGEMODE.1 — the coach picker's pool. A failed load used to store `[]`,
// which (a) the picker rendered as "No available coaches to add." and (b)
// ManageMode's openPicker, which only fetches while the pool is `null`, never
// retried for the life of the mount. A failed FIRST load now stays `null`
// (the next open retries) and says why; a failed REFRESH of a pool already
// loaded keeps that pool, since an assign/remove refresh is background work.
export const STAFF_LOAD_FAILED = 'The coach list could not be loaded. Try again.'

/**
 * @param {{ res: any, current: any[]|null }} args
 * @returns {{ staff: any[]|null, error: string|null }}
 */
export function staffLoadOutcome({ res, current }) {
  if (res?.success) {
    if (res.data == null) return { staff: [], error: null }
    if (Array.isArray(res.data)) return { staff: res.data, error: null }
  }
  if (Array.isArray(current)) return { staff: current, error: null }
  // The server's reason rides along: a 403 and a network blip are different
  // things to act on (the Alert this replaced showed it too).
  const reason = !res?.success && res?.error ? ` (${res.error})` : ''
  return { staff: null, error: `${STAFF_LOAD_FAILED}${reason}` }
}
