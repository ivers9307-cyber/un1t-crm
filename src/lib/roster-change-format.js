// src/lib/roster-change-format.js
// CHANGELOG.1 — turn one roster_change_log row (the shape
// GET /api/schedule/change-log returns) into words a manager can read:
//
//   "Assigned Coach A to Tue 15 Sep 6am"   +   "told 14:02"
//
// Shift times use formatTime12h, the form the calendar cards print, so a
// manager reads the same "6am" in the drawer and on the card behind it.
//
// Pure. It lives in src/lib, not shared/, because anything under shared/
// publishes an OTA and the phone does not show this.
//
// Two kinds of time are in play and they are handled differently on purpose:
//   block_date / start_time  bare Dublin wall-clock values. Never parsed as
//                            UTC (the BST off-by-one in CLAUDE.md): the
//                            weekday is read from LOCAL date components.
//   notified_at / created_at timestamptz instants, shown as Dublin wall-clock
//                            via dublin-time.js.
//
// `details` arrives already whitelisted by shapeRosterChange
// (roster-change-log.js): known keys, string-or-null values, HH:MM(:SS) times,
// allow-listed reasons. This module still trusts none of it: an unknown shape
// degrades to the plain sentence and nothing is guessed.

import { formatTime12h } from './schedule-overlap'
import { dublinDayStr, dublinTimeLabel } from './dublin-time'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Ceiling on one drawer's rows (a multiple of the read's 1,000-row page). Past
 * it the answer is flagged `truncated`. It lives HERE, in the pure client-safe
 * module, because the drawer prints it; roster-change-log.js re-exports it.
 */
export const ROSTER_CHANGE_LOG_MAX_ROWS = 5000

const REASON_NOTE = {
  staff_permanent_delete: 'staff member deleted',
}

// ── A stamp is not always a message ─────────────────────────────────────────
//
// notified_at means "the re-publish safety net must not message this coach
// about this row", which is NOT the same as "this coach was told". Every writer
// that stamps WITHOUT sending the coach a roster message (grepped 2026-09-20;
// re-grep `notified_at` and `markChangesNotified` when adding a writer):
//
//   1. mig 622, the permanent staff delete: details.reason =
//      'staff_permanent_delete', stamped in the INSERT. The coach is gone.
//   2. swaps/[id]/route.js, an approved DROP on a DRAFT roster: via
//      'swap_drop' with roster_status other than 'published' (an unreadable
//      status is treated as a draft there too). Stamped unconditionally.
//   3. A shift already OVER on the Dublin day the stamp was made:
//      notifyRosterChanges (all-past coach, and the past rows of a mixed
//      coach), swaps/[id]/route.js (isPast, drop and move rows) and
//      renotifyChangedCoaches (stamps every collected row, messages about
//      future ones only).
//   4. notifyRosterChanges, coach === actor: they made the change themselves,
//      so there was nobody to tell. The API row carries it as `self_change`.
//
// For these the drawer shows NO told state, rather than a time nobody was told at.
//
// And one writer whose stamp ALWAYS means told, so rules 3 and 4 must not
// touch it:
//
//   5. assignments/[id]/route.js PUT (the assignment editor's hours change):
//      action 'time_changed' with details EXACTLY { start_time_override,
//      end_time_override } (both keys, either may be null). It messages the
//      coach with no past-date check and no self check, and stamps the row
//      ONLY on confirmed delivery, in the same request. A manager correcting
//      yesterday's hours really did tell the coach.
//      The exemption covers THAT stamp only, recognised by being made within
//      OWN_STAMP_WINDOW_MS of the row: if delivery failed, the row stays
//      unstamped until renotifyChangedCoaches stamps it at a later re-publish,
//      and that one is rule 3 like any other row.
//      Rules 1 and 2 are checked first regardless. They cannot coexist with
//      this shape in practice (mig 622 writes action 'unassigned' with details
//      { reason } and nothing else; a swap drop is 'unassigned' with `via`),
//      so that ordering is a guard, not a case.
const OWN_STAMP_WINDOW_MS = 10 * 60 * 1000
export const NO_MESSAGE_REASONS = Object.freeze(['staff_permanent_delete'])

const VIA_NOTE = {
  copy_week: 'copied from another week',
  copy_month: 'copied from another month',
  slot_deleted: 'slot deleted',
  swap: 'shift swap',
  swap_drop: 'dropped shift approved',
}

function dateParts(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) } : null
}

/** '2026-09-15' -> '15 Sep'. '' when unreadable. */
function shortDate(iso) {
  const p = dateParts(iso)
  return p ? `${p.d} ${MONTHS[p.mo - 1]}` : ''
}

/** '2026-09-15' -> 'Tue 15 Sep'. Built AND read in local components, so the host TZ cannot move it. */
function dayLabel(iso) {
  const p = dateParts(iso)
  if (!p) return ''
  return `${DAYS[new Date(p.y, p.mo - 1, p.d).getDay()]} ${shortDate(iso)}`
}

/** 'HH:MM(:SS)' -> the calendar card's '6am' / '6:30am'. '' for anything else, never 'NaNam'. */
function timeLabel(t) {
  return typeof t === 'string' && /^\d{2}:\d{2}(:\d{2})?$/.test(t) ? formatTime12h(t) : ''
}

function whenLabel(blockDate, startTime) {
  const day = dayLabel(blockDate)
  if (!day) return 'a shift'
  const t = timeLabel(startTime)
  return t ? `${day} ${t}` : day
}

function lookup(table, key) {
  return typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : ''
}

function howNote(details) {
  if (details?.source === 'template_edit') return ' (template edited)'
  const text = lookup(REASON_NOTE, details?.reason) || lookup(VIA_NOTE, details?.via)
  return text ? ` (${text})` : ''
}

/** What happened, for whom. */
export function rosterChangeSentence(change) {
  const c = change || {}
  const d = c.details || {}
  const coach = c.coach_name || 'a coach'
  const when = whenLabel(c.block_date, c.start_time)

  if (c.action === 'assigned') return `Assigned ${coach} to ${when}${howNote(d)}`
  if (c.action === 'unassigned') return `Removed ${coach} from ${when}${howNote(d)}`

  if (c.action === 'time_changed') {
    // A template edit moved the BLOCK, so the row's start_time is already the
    // new one. Name the shift by the time it USED to be.
    const movedTo = [timeLabel(d.to?.start_time), timeLabel(d.to?.end_time)]
    if (movedTo[0] && movedTo[1]) {
      const was = whenLabel(c.block_date, timeLabel(d.from?.start_time) ? d.from.start_time : c.start_time)
      return `Moved ${coach}'s ${was} shift to ${movedTo[0]}–${movedTo[1]}${howNote(d)}`
    }
    // Each override is a time, or null (= cleared). Anything else is not an
    // override this module understands, and it says only what it knows.
    const isOverride = (v) => v === null || Boolean(timeLabel(v))
    const hasOverrides = 'start_time_override' in d && 'end_time_override' in d
      && isOverride(d.start_time_override) && isOverride(d.end_time_override)
    if (hasOverrides && d.start_time_override === null && d.end_time_override === null) {
      return `Reset ${coach}'s hours on ${when} to the shift's own`
    }
    if (hasOverrides) {
      const start = timeLabel(d.start_time_override || c.start_time)
      const end = timeLabel(d.end_time_override || c.end_time)
      if (start && end) return `Changed ${coach}'s hours on ${when} to ${start}–${end}`
    }
    return `Changed ${coach}'s hours on ${when}`
  }

  return `Changed ${coach}'s shift on ${when}`
}

function isInstant(v) {
  return Boolean(v) && Number.isFinite(Date.parse(v))
}

/**
 * Does this row's stamp mean the coach was sent something? See the list above
 * NO_MESSAGE_REASONS. Only meaningful for a row that HAS a stamp.
 */
/** Writer 5 above: the assignment editor's row, carrying the stamp that writer made itself. */
function isDeliveredTimeEdit(c, d) {
  if (c.action !== 'time_changed' || !('start_time_override' in d) || !('end_time_override' in d)) return false
  if (!isInstant(c.notified_at) || !isInstant(c.created_at)) return false
  const gap = Date.parse(c.notified_at) - Date.parse(c.created_at)
  return gap >= 0 && gap <= OWN_STAMP_WINDOW_MS
}

export function stampMeansTold(change) {
  const c = change || {}
  const d = c.details || {}
  if (NO_MESSAGE_REASONS.includes(d.reason)) return false
  if (d.via === 'swap_drop' && 'roster_status' in d && d.roster_status !== 'published') return false
  if (isDeliveredTimeEdit(c, d)) return true
  if (c.self_change === true) return false
  // 'YYYY-MM-DD' strings compare correctly as text. The stamp's day is the
  // DUBLIN day, which is the "today" every writer judged "past" against.
  if (dateParts(c.block_date) && isInstant(c.notified_at) && String(c.block_date).slice(0, 10) < dublinDayStr(c.notified_at)) return false
  return true
}

/**
 * Has the coach been told, and when (Dublin wall-clock). null = this row has
 * a stamp that does not mean anybody was told, so there is no told state to show.
 */
export function rosterChangeTold(change) {
  const c = change || {}
  if (!c.notified_at) return 'not told yet'
  if (!stampMeansTold(c)) return null
  if (!isInstant(c.notified_at)) return 'told'
  const time = dublinTimeLabel(c.notified_at)
  const toldDay = dublinDayStr(c.notified_at)
  // The day is only worth naming when it is not the day of the change.
  const sameDay = isInstant(c.created_at) && dublinDayStr(c.created_at) === toldDay
  return sameDay ? `told ${time}` : `told ${shortDate(toldDay)} ${time}`
}

/** Who made the change, and when. */
export function rosterChangeByline(change) {
  const c = change || {}
  const who = c.actor_name || 'System'
  if (!isInstant(c.created_at)) return who
  return `${who} · ${shortDate(dublinDayStr(c.created_at))} ${dublinTimeLabel(c.created_at)}`
}
