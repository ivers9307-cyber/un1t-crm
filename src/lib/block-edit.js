// src/lib/block-edit.js
// BLOCKEDIT.1 — what editing ONE shift block means, decided outside the route.
//
// PUT /api/schedule/blocks/[id] edits start/end time, min/max coaches and the
// coach-visible briefing of one shift_blocks row. Everything that DECIDES is
// here and pure; the route only reads, writes, logs and answers.
//
//   - end after start (shift_blocks_time_order, mig 067), max >= min (mig 177)
//   - an admin shift has no minimum (SHIFTTYPE.1: adminMinimumRefusal)
//   - a max below the live coaches already on it is a 409 unless the caller
//     sends allow_below_assigned (the assign route's allow_over_capacity rule)
//   - D3: a coach's override EQUAL to the block's OLD time follows the block
//     (cleared); any other override is a deliberate partial shift and stays
//   - equal values are a no-op: nothing is written, logged or told

import { liveAssignments } from './roster'
import { adminMinimumRefusal } from './shift-template-kind'
import { formatTime12h, formatTimeRange12h } from './schedule-overlap'
import { shiftKindOf } from '@shared/shift-kind'
import { normaliseBriefing } from '@shared/shift-briefing'
import { inStaffPushHours, staffWallClockHHMM, STAFF_PUSH_FROM } from './staff-push-hours'
import { dublinDayStr, addDaysISO } from './dublin-time'

export const BLOCK_EDIT_FIELDS = ['start_time', 'end_time', 'min_coaches', 'max_coaches', 'briefing']

// The `details.source` every change-log row this edit writes carries: the
// coachless block_edited row and each coach's time_changed row. The notice arm
// (block-edit-notify.js) reads rows by it. Declared here, in the pure module,
// so the route does not import the push stack just for a string.
export const TIME_CHANGE_SOURCE = 'block_edit'

/** 'HH:MM' or 'HH:MM:SS…' → 'HH:MM:SS'; null for anything else. Postgres `time` renders HH:MM:SS. */
export function toHms(t) {
  if (typeof t !== 'string') return null
  if (/^\d{2}:\d{2}$/.test(t)) return `${t}:00`
  if (/^\d{2}:\d{2}:\d{2}/.test(t)) return t.slice(0, 8)
  return null
}

/**
 * Review fix 2 — does the stored block still hold what the manager's form
 * OPENED with? `expected` is { start_time, end_time, min_coaches, max_coaches }.
 * The route's conditional UPDATE only guards against a change between its own
 * read and its write; this catches a change made while the form sat open.
 */
export function matchesExpected(block, expected) {
  if (!expected) return true
  return toHms(block?.start_time) === toHms(expected.start_time)
    && toHms(block?.end_time) === toHms(expected.end_time)
    && block?.min_coaches === expected.min_coaches
    && block?.max_coaches === expected.max_coaches
}

/** Two { start_time, end_time } windows are the same time. */
export function sameWindow(a, b) {
  return toHms(a?.start_time) === toHms(b?.start_time) && toHms(a?.end_time) === toHms(b?.end_time)
}

function refuse(status, error, message, extra = {}) {
  return { ok: false, status, body: { success: false, error, message, ...extra } }
}

const coaches = (n) => `${n} ${n === 1 ? 'coach is' : 'coaches are'}`

/**
 * @param {object} args
 * @param {object} args.block  shift_blocks row with shift_templates(name, kind)
 *   and shift_assignments(id, profile_id, status, start/end_time_override, profiles(full_name))
 * @param {object} args.body   the validated PUT body
 */
export function planBlockEdit({ block, body = {} }) {
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k)
  if (!BLOCK_EDIT_FIELDS.some(has)) return refuse(400, 'nothing_to_change', 'Nothing to change.')

  const refusal = adminMinimumRefusal(shiftKindOf(block), has('min_coaches') ? body.min_coaches : undefined)
  if (refusal) return { ok: false, ...refusal }

  const prior = {
    start: toHms(block.start_time),
    end: toHms(block.end_time),
    min: block.min_coaches,
    max: block.max_coaches,
    briefing: normaliseBriefing(block.briefing),
  }
  const next = {
    start: has('start_time') ? toHms(body.start_time) : prior.start,
    end: has('end_time') ? toHms(body.end_time) : prior.end,
    min: has('min_coaches') ? body.min_coaches : prior.min,
    max: has('max_coaches') ? body.max_coaches : prior.max,
    briefing: has('briefing') ? normaliseBriefing(body.briefing) : prior.briefing,
  }
  if (!next.start || !next.end || next.end <= next.start) {
    return refuse(400, 'end_not_after_start', 'A shift must end after it starts.')
  }
  if (next.min > next.max) {
    return refuse(400, 'min_above_max', `The minimum (${next.min}) cannot be more than the maximum (${next.max}).`)
  }

  const changed = {
    start: next.start !== prior.start,
    end: next.end !== prior.end,
    min: next.min !== prior.min,
    max: next.max !== prior.max,
    briefing: next.briefing !== prior.briefing,
  }
  if (!Object.values(changed).some(Boolean)) return { ok: true, unchanged: true }
  const timesChanged = changed.start || changed.end

  const live = liveAssignments(block.shift_assignments)
  const warnings = []
  if (changed.max && next.max < live.length) {
    if (body.allow_below_assigned !== true) {
      return refuse(409, 'below_assigned',
        `${coaches(live.length)} on this shift, more than a maximum of ${next.max}. Remove someone first, or save anyway.`,
        { assigned: live.length })
    }
    warnings.push(`${coaches(live.length)} on this shift, above its new maximum of ${next.max}. Nobody was removed.`)
  }

  const patch = {}
  if (changed.start) patch.start_time = next.start
  if (changed.end) patch.end_time = next.end
  if (changed.min) patch.min_coaches = next.min
  if (changed.max) patch.max_coaches = next.max
  if (changed.briefing) patch.briefing = next.briefing

  const followUpdates = []
  const affected = []
  const kept = []
  const invalid = []
  const outside = []
  if (timesChanged) {
    for (const a of live) {
      const sOv = toHms(a.start_time_override)
      const eOv = toHms(a.end_time_override)
      // D3 — an override equal to the OLD block time says nothing the block
      // did not; it follows. Judged per field, only where the block moved.
      const sFollows = changed.start && sOv !== null && sOv === prior.start
      const eFollows = changed.end && eOv !== null && eOv === prior.end
      const sKept = sFollows ? null : sOv
      const eKept = eFollows ? null : eOv
      const from = { start_time: sOv ?? prior.start, end_time: eOv ?? prior.end }
      const to = { start_time: sKept ?? next.start, end_time: eKept ?? next.end }
      // What the coach really works if clearing the override fails.
      const toIfStuck = { start_time: sOv ?? next.start, end_time: eOv ?? next.end }
      if (sFollows || eFollows) {
        followUpdates.push({
          assignmentId: a.id,
          coachId: a.profile_id,
          patch: { ...(sFollows ? { start_time_override: null } : {}), ...(eFollows ? { end_time_override: null } : {}) },
          // The RAW stored values, so the guarded UPDATE matches the row as read.
          expect: { ...(sFollows ? { start_time_override: a.start_time_override } : {}), ...(eFollows ? { end_time_override: a.end_time_override } : {}) },
        })
      }
      const name = a.profiles?.full_name || 'A coach'
      // Review fix 1 — a window that ends at or before it starts is not a
      // shift: payroll's shiftHours wraps it (~23.5h) and the notice would
      // read backwards. Refused below, naming every such coach.
      if (to.end_time <= to.start_time) {
        invalid.push(name)
        continue
      }
      // An override on a field the edit did NOT move stays; if it now sits
      // outside the shift's new hours the manager is told (not refused: a
      // coach may genuinely start early or stay late).
      if (!changed.start && sOv !== null && (sOv < next.start || sOv > next.end)) {
        outside.push({ name, which: 'start', time: sOv })
      }
      if (!changed.end && eOv !== null && (eOv < next.start || eOv > next.end)) {
        outside.push({ name, which: 'finish', time: eOv })
      }
      if (!sameWindow(from, to)) affected.push({ assignmentId: a.id, coachId: a.profile_id, from, to, toIfStuck })
      if ((changed.start && sKept !== null) || (changed.end && eKept !== null)) {
        kept.push({ assignmentId: a.id, coachId: a.profile_id, name: a.profiles?.full_name || 'A coach', window: to })
      }
    }
  }
  if (invalid.length > 0) {
    return refuse(409, 'coach_window_invalid',
      `${invalid.join(', ')} would finish at or before they start: their own hours do not fit the new times. Change their hours first.`,
      { coaches: invalid })
  }
  for (const k of kept) {
    warnings.push(`${k.name} keeps their own hours (${formatTimeRange12h(k.window.start_time, k.window.end_time)}), which did not move with the shift.`)
  }

  const newRange = formatTimeRange12h(next.start, next.end)
  for (const o of outside) {
    warnings.push(`${o.name}'s own ${o.which} time (${formatTime12h(o.time)}) is outside the shift's new hours (${newRange}).`)
  }

  // D4 — the coachless block_edited row. What changed, never the briefing text.
  const blockDetails = { source: TIME_CHANGE_SOURCE }
  if (timesChanged) {
    blockDetails.from = { start_time: prior.start, end_time: prior.end }
    blockDetails.to = { start_time: next.start, end_time: next.end }
  }
  if (changed.min) blockDetails.min_coaches = { from: prior.min, to: next.min }
  if (changed.max) blockDetails.max_coaches = { from: prior.max, to: next.max }
  if (changed.briefing) {
    blockDetails.briefing = prior.briefing === null ? 'added' : next.briefing === null ? 'removed' : 'changed'
  }

  return { ok: true, unchanged: false, patch, next, changed, followUpdates, affected, kept, warnings, blockDetails }
}

/**
 * When will the coaches hear about a time change? The 5-minute notice arm sends
 * only inside staff quiet hours (07:00-22:00 at the studio).
 *   'shortly'  in band now: the next tick.
 *   'morning'  quiet now: from 07:00 on the next morning.
 *   'too_late' quiet now, and the shift is on that very morning with a start
 *              (old OR new, any coach) before 07:00: it will have started
 *              before anyone is told, so the manager must ring them.
 * @param {{ nowMs: number, timeZone?: string|null, blockDate: string,
 *           windows: Array<{ from: {start_time}, to: {start_time} }> }} args
 */
export function blockEditNoticeWhen({ nowMs, timeZone, blockDate, windows = [] }) {
  if (inStaffPushHours(nowMs, timeZone)) return 'shortly'
  const wall = staffWallClockHHMM(nowMs, timeZone) || '00:00'
  const today = dublinDayStr(nowMs)
  const noticeDay = wall < STAFF_PUSH_FROM ? today : addDaysISO(today, 1)
  const early = windows.some((w) => [w.from?.start_time, w.to?.start_time]
    .some((t) => toHms(t) !== null && toHms(t).slice(0, 5) < STAFF_PUSH_FROM))
  return blockDate === noticeDay && early ? 'too_late' : 'morning'
}

/**
 * Second review 3 — is this coach's shift already OVER? D8: a past shift is
 * never messaged. Past = dated before today (Dublin), or today with both the
 * old and the new end at or before the wall clock now. (An ended shift pulled
 * back into the future by a later end is not over: the coach may go back.)
 * @param {{ blockDate: string, from: {end_time}, to: {end_time}, nowMs: number, timeZone?: string|null }} args
 */
export function coachShiftOver({ blockDate, from, to, nowMs, timeZone }) {
  const today = dublinDayStr(nowMs)
  if (blockDate < today) return true
  if (blockDate > today) return false
  const now = staffWallClockHHMM(nowMs, timeZone)
  const ends = [from?.end_time, to?.end_time].map(toHms).filter(Boolean).map((t) => t.slice(0, 5))
  if (!now || ends.length === 0) return false
  return ends.every((e) => e <= now)
}

/** The web toast's second half, from the PUT response's `notice`. '' when nobody is told. */
export function blockEditNoticeText(notice) {
  if (!notice || !(notice.coaches > 0)) return ''
  const who = notice.coaches === 1 ? 'The coach on this shift' : `The ${notice.coaches} coaches on this shift`
  if (notice.when === 'past') {
    return `Saved. This shift is over, so ${notice.coaches === 1 ? 'the coach is' : `the ${notice.coaches} coaches are`} not notified.`
  }
  if (notice.when === 'too_late') {
    return `Saved. ${who} will NOT be told before it starts (no notifications before 7am). Ring them.`
  }
  return notice.when === 'morning'
    ? `Saved. ${who} will be told after 7am (no notifications overnight).`
    : `Saved. ${who} will be told in the next few minutes.`
}
