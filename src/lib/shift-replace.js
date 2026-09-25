// src/lib/shift-replace.js
//
// REPLACE.1a — the PURE half of "replace coach": hand one assignment from
// coach A to coach B in one action. May it happen now, what the change log
// records, what the manager is told, and what the held-notice arm sends.
//
// The DB half is ./shift-replace-server.js; the route is
// src/app/api/schedule/assignments/[id]/replace/route.js; the arm is
// ./shift-replace-notify.js.
//
// In short: ONE guarded UPDATE moves A's row to B (no migration, no RPC);
// nothing carries from A to B (SWAPS.2: a shift that changes hands starts
// clean); a started shift or an arrived coach is refused; leave or a clash
// for B is the swap approval's confirm step; on a published roster, two
// change-log rows via 'replace' and ONE notice each, now inside 07:00-22:00
// studio time and from 07:00 otherwise (quiet hours gate the NOTICE, never
// the replace).

import { swapShiftHasStarted } from './swap-cover'
import { inStaffPushHours } from './staff-push-hours'
import { SWAP_CONFLICTS_CODE } from './swap-lifecycle'
import { isLiveAssignment } from './roster'
import { isRosterableProfile, notRosterableError } from './roster-write'

/** roster_change_log.details.via on both rows of a replace. The held-notice arm filters on it. */
export const REPLACE_VIA = 'replace'

/**
 * shift_swap_requests.review_note on an open swap closed because a manager
 * gave its shift to someone else. reviewed_by is set to that manager, so
 * the cover sweep's pass 2, which reads only rows with NO reviewer, never
 * takes it for a system close that owes an expiry notice.
 */
export const REPLACE_SWAP_CLOSE_NOTE = 'Closed: a manager gave this shift to another coach.'

/**
 * roster_change_log.details.reason on the rows of a replace undone before its
 * held notice went out (netReplaceChanges' `silent`). The arm stamps them with
 * no message; the drawer reads the reason as "nobody was told"
 * (roster-change-format.js NO_MESSAGE_REASONS) instead of printing a told time.
 */
export const REPLACE_UNDONE_REASON = 'replace_undone'

/**
 * REPLACE.1a review 3 — roster_change_log.details.reason on the rows of a
 * replace whose shift had STARTED (studio clock) before its held notice could
 * go out. Telling B at 07:00 about a 06:00 shift is no use; the manager was
 * told to ring. The arm stamps them with no message; the drawer reads the
 * reason as "nobody was told".
 */
export const REPLACE_STARTED_REASON = 'replace_shift_started'

/**
 * REPLACE.1a review 4 — details.reason on a replace "assigned" row whose shift
 * was DELETED before its held notice went out: telling the incoming coach
 * about a shift that is gone is wrong (the slot delete told whoever was on
 * it). Stamped with no message.
 */
export const REPLACE_DELETED_REASON = 'replace_shift_deleted'

// The route's after() owns a fresh replace notice for this long; after it the
// */5 arm may send it (the arm is also the recovery for an after() that died).
export const REPLACE_NOTICE_ROUTE_OWNS_MS = 2 * 60 * 1000
// Older than this, a row is left to the re-publish safety net.
export const REPLACE_NOTICE_MAX_AGE_MS = 48 * 60 * 60 * 1000

const REFUSALS = Object.freeze({
  not_live: { status: 409, error: 'This coach is no longer on this shift. Refresh and try again.' },
  same_coach: { status: 400, error: 'Pick a different coach: this one is already on the shift.' },
  already_arrived: { status: 409, error: 'This coach has already arrived for the shift, so it cannot be handed on. Add the new coach and adjust the times instead.' },
  shift_started: { status: 409, error: 'This shift has already started, so it cannot be handed on. Add the new coach and adjust the times instead.' },
  not_at_studio: { status: 400, error: 'This coach is not on the staff of this studio.' },
  already_on_shift: { status: 409, error: 'That coach is already on this shift.' },
  changed: { status: 409, error: 'This shift has just changed. Refresh and try again.' },
})

const refusal = (code) => ({ code, ...REFUSALS[code] })

/** A refusal code (from replaceRefusal or the write) -> the route's answer. */
export function replaceRefusalResponse(code) {
  const r = REFUSALS[code] || { status: 400, error: 'Could not replace the coach.' }
  return { status: r.status, body: { success: false, code, error: r.error } }
}

/**
 * Has the shift started, for a replace? The incoming coach works the
 * BLOCK's window (nothing carries), and the outgoing coach may have begun
 * earlier on an override: either start having passed refuses. The ONE
 * predicate (swapShiftHasStarted: studio wall clock, DST-exact, an unreadable
 * date or time is NOT started).
 */
export function replaceShiftStarted({ block, assignment }, nowMs, tz) {
  if (!block?.block_date) return false
  const atBlock = { block_date: block.block_date, start_time: block.start_time }
  const atOwn = { ...atBlock, start_time_override: assignment?.start_time_override ?? null }
  return swapShiftHasStarted(atBlock, nowMs, tz) || swapShiftHasStarted(atOwn, nowMs, tz)
}

/**
 * May `assignment` go to `toProfileId` right now? Pure. The order is the
 * order a manager can act on, and a non-member is refused BEFORE their profile
 * is judged, so nothing about a foreign profile is described.
 *
 * @param {object} a
 * @param {object|null} a.assignment    shift_assignments row (id, profile_id, status, arrived_at)
 * @param {string} a.toProfileId
 * @param {boolean} a.started           replaceShiftStarted(...)
 * @param {boolean} a.toIsMember        B has a profile_locations row at the block's studio
 * @param {object|null} a.toProfile     B's profiles row (read only when a member)
 * @param {string[]} a.liveOnBlockIds   profile ids live on the block now
 * @returns {null | { code: string, status: number, error: string }}
 */
export function replaceRefusal({ assignment, toProfileId, started, toIsMember, toProfile, liveOnBlockIds = [] }) {
  if (!assignment || !isLiveAssignment(assignment)) return refusal('not_live')
  if (toProfileId === assignment.profile_id) return refusal('same_coach')
  if (assignment.arrived_at) return refusal('already_arrived')
  if (started) return refusal('shift_started')
  if (!toIsMember) return refusal('not_at_studio')
  if (!isRosterableProfile(toProfile)) {
    const e = notRosterableError(toProfile)
    return { code: e.code, status: 400, error: e.message }
  }
  if (liveOnBlockIds.includes(toProfileId)) return refusal('already_on_shift')
  return null
}

/** The two changes (logRosterChange + notifyRosterChanges shapes), A off then B on. */
export function replaceChanges({ block, fromProfileId, toProfileId }) {
  const base = { blockId: block.id, blockDate: block.block_date, startTime: block.start_time ?? null }
  return [
    { ...base, coachId: fromProfileId, action: 'unassigned' },
    { ...base, coachId: toProfileId, action: 'assigned' },
  ]
}

/** 'none' (draft: the first publish tells them) | 'now' | 'morning' (quiet hours: the arm sends from 07:00). */
export function replaceNoticeWhen({ published, inBand }) {
  if (!published) return 'none'
  return inBand ? 'now' : 'morning'
}

function conflictMessage(body) {
  const lines = (Array.isArray(body?.conflicts) ? body.conflicts : []).map((c) => c?.message).filter(Boolean)
  return [...new Set(lines)].join(' ') || body?.error || 'This coach has a clash that day.'
}

/**
 * The web toast after POST /replace. { kind: 'confirm' } asks "Replace
 * anyway?" (resend with confirm_conflicts); { kind: 'error' } keeps the dialog
 * open; { kind: 'done', tone } closes it.
 */
export function replaceResponseOutcome(status, body, { fromName, toName } = {}) {
  const from = fromName || 'The coach'
  const to = toName || 'The new coach'
  if (status === 409 && body?.code === SWAP_CONFLICTS_CODE) return { kind: 'confirm', message: conflictMessage(body) }
  if (!(status >= 200 && status < 300) || body?.success !== true) {
    return { kind: 'error', message: body?.error || 'Could not replace the coach.' }
  }
  const notice = body?.data?.notice
  if (notice === 'morning') {
    // Review 3 — it asks the manager to ring, so it stays until dismissed.
    // "At or before 7am": the arm stamps a shift that has started by the time
    // it may send (07:00 at the earliest) without telling anyone.
    return { kind: 'done', tone: 'warning', sticky: true, message: `${to} is on the shift. ${from} and ${to} are told after 7am; if the shift is at or before 7am, ring them.` }
  }
  if (notice === 'none') {
    return { kind: 'done', tone: 'success', message: `${to} is on the shift. The roster is a draft, so nobody is told until it is published.` }
  }
  return { kind: 'done', tone: 'success', message: `${to} is on the shift. ${from} and ${to} have been told.` }
}

/** The picker's words in replace mode (web AssignCoachModal). */
export function replacePickerCopy({ fromName, pickedName = null, saving = false } = {}) {
  return {
    title: fromName ? `Replace ${fromName}` : 'Replace coach',
    label: 'Pick the coach who takes this shift',
    submit: saving ? 'Replacing…' : pickedName ? `Replace with ${pickedName}` : 'Pick a coach',
  }
}

// The */5 cron's tick. Quiet hours are a 9-hour band, so stepping at the
// tick never jumps over a band.
const TICK_MS = 5 * 60 * 1000

/**
 * REPLACE.1a review 1 — was there any moment in [fromMs, toMs) inside
 * 07:00-22:00 at `tz`? A replace row made in band was sent by the route's
 * after(), and one made overnight may have been sent by an earlier in-band
 * tick; either way its coach may already have heard, even though the row is
 * unstamped (a stamp can fail after a delivery). `toMs` itself is excluded:
 * the tick asking has not sent anything yet. Unreadable input says true, the
 * answer that can only cost a duplicate.
 */
export function bandSeenBetween(fromMs, toMs, tz) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return true
  for (let t = fromMs; t < toMs; t += TICK_MS) {
    if (inStaffPushHours(t, tz)) return true
  }
  return false
}

const byTime = (x, y) => String(x.created_at).localeCompare(String(y.created_at)) || String(x.id).localeCompare(String(y.id))

/**
 * The held-notice arm's plan. Rows are unstamped roster_change_log rows
 * with details.via = 'replace'. Per (coach, shift): if the assigned and
 * unassigned rows balance, the net change is nothing and every row is stamped
 * silently; otherwise the LAST row's action is the net change, told once, on
 * behalf of that row's actor.
 *
 * REPLACE.1a review 1 — "nothing" is only nothing if nobody could have heard
 * of any of it. When `mayHaveBeenTold(row)` is true for a row of a balanced
 * pile (its notice may have gone out and only the stamp failed), the pile
 * tells its LAST action instead: at worst a coach hears again, never "added"
 * without "removed".
 *
 * @returns {{ send: Array<{locationId, actorId, coachId, blockId, blockDate, startTime, action, rowIds}>,
 *             silent: Array<{ locationId, coachId, rowIds }>,
 *             gone: Array<{ locationId, coachId, rowIds }> }}  gone: review 4
 */
export function netReplaceChanges(rows, { mayHaveBeenTold = () => false } = {}) {
  const groups = new Map()
  for (const r of rows || []) {
    if (!r?.coach_id || !r.block_date || !r.location_id) continue
    if (r.action !== 'assigned' && r.action !== 'unassigned') continue
    const key = replacePileKey(r)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }
  const send = []
  const silent = []
  const gone = []
  for (const list of groups.values()) {
    list.sort(byTime)
    const last = list[list.length - 1]
    const rowIds = list.map((r) => r.id)
    // Review 4 — the slot was deleted (block_id is ON DELETE SET NULL). A
    // blockless row is its own pile. "Added" to a shift that no longer exists
    // is not news (the slot delete told whoever was on it): stamped silently.
    // "Removed" is still owed, on the row's date.
    if (!last.block_id && last.action === 'assigned') {
      gone.push({ locationId: last.location_id, coachId: last.coach_id, rowIds })
      continue
    }
    const on = list.filter((r) => r.action === 'assigned').length
    if (on * 2 === list.length && !list.some((r) => mayHaveBeenTold(r))) {
      silent.push({ locationId: last.location_id, coachId: last.coach_id, rowIds })
      continue
    }
    send.push({
      locationId: last.location_id,
      actorId: last.actor_id ?? null,
      coachId: last.coach_id,
      blockId: last.block_id ?? null,
      blockDate: last.block_date,
      startTime: last.shift_blocks?.start_time ?? null,
      action: last.action,
      rowIds,
    })
  }
  return { send, silent, gone }
}

/**
 * The pile a replace row belongs to: its coach on its shift, or, once the
 * shift is deleted (block_id null), the row alone. Exported so the arm's
 * "is anyone in this pile still changing?" check groups exactly the same way.
 */
export function replacePileKey(r) {
  return r?.block_id ? `${r.location_id}|${r.coach_id}|${r.block_id}` : `row|${r?.id}`
}
