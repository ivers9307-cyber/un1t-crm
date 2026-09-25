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
import { formatTimeRange12h } from './schedule-overlap'
import { shiftKindOf } from '@shared/shift-kind'
import { normaliseBriefing } from '@shared/shift-briefing'

export const BLOCK_EDIT_FIELDS = ['start_time', 'end_time', 'min_coaches', 'max_coaches', 'briefing']

/** 'HH:MM' or 'HH:MM:SS…' → 'HH:MM:SS'; null for anything else. Postgres `time` renders HH:MM:SS. */
export function toHms(t) {
  if (typeof t !== 'string') return null
  if (/^\d{2}:\d{2}$/.test(t)) return `${t}:00`
  if (/^\d{2}:\d{2}:\d{2}/.test(t)) return t.slice(0, 8)
  return null
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
      if (!sameWindow(from, to)) affected.push({ assignmentId: a.id, coachId: a.profile_id, from, to, toIfStuck })
      if ((changed.start && sKept !== null) || (changed.end && eKept !== null)) {
        kept.push({ assignmentId: a.id, coachId: a.profile_id, name: a.profiles?.full_name || 'A coach', window: to })
      }
    }
  }
  for (const k of kept) {
    warnings.push(`${k.name} keeps their own hours (${formatTimeRange12h(k.window.start_time, k.window.end_time)}), which did not move with the shift.`)
  }

  // D4 — the coachless block_edited row. What changed, never the briefing text.
  const blockDetails = { source: 'block_edit' }
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

/** The web toast's second half, from the PUT response's `notice`. '' when nobody is told. */
export function blockEditNoticeText(notice) {
  if (!notice || !(notice.coaches > 0)) return ''
  const who = notice.coaches === 1 ? 'The coach on this shift' : `The ${notice.coaches} coaches on this shift`
  return notice.when === 'morning'
    ? `Saved. ${who} will be told after 7am (no notifications overnight).`
    : `Saved. ${who} will be told in the next few minutes.`
}
