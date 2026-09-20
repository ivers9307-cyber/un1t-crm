// src/lib/roster-change-format.js
// CHANGELOG.1 — turn one roster_change_log row (the shape
// GET /api/schedule/change-log returns) into words a manager can read:
//
//   "Assigned Coach A to Tue 15 Sep 06:00 · told 14:02"
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
// `details` is whatever the writer recorded (surveyed in the CHANGELOG.1 plan).
// An unknown shape degrades to the plain sentence; nothing is guessed.

import { fmtTime } from './schedule-overlap'
import { dublinDayStr, dublinTimeLabel } from './dublin-time'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

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

function whenLabel(blockDate, startTime) {
  const day = dayLabel(blockDate)
  if (!day) return 'a shift'
  const t = fmtTime(startTime)
  return t ? `${day} ${t}` : day
}

function howNote(details) {
  if (details?.source === 'template_edit') return ' (template edited)'
  const text = VIA_NOTE[details?.via]
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
    if (d.to?.start_time) {
      const was = whenLabel(c.block_date, d.from?.start_time || c.start_time)
      return `Moved ${coach}'s ${was} shift to ${fmtTime(d.to.start_time)}–${fmtTime(d.to.end_time)}${howNote(d)}`
    }
    const hasOverrideKeys = 'start_time_override' in d || 'end_time_override' in d
    if (hasOverrideKeys && !d.start_time_override && !d.end_time_override) {
      return `Reset ${coach}'s hours on ${when} to the shift's own`
    }
    if (hasOverrideKeys) {
      const start = fmtTime(d.start_time_override || c.start_time)
      const end = fmtTime(d.end_time_override || c.end_time)
      return `Changed ${coach}'s hours on ${when} to ${start}–${end}`
    }
    return `Changed ${coach}'s hours on ${when}`
  }

  return `Changed ${coach}'s shift on ${when}`
}

function isInstant(v) {
  return Boolean(v) && Number.isFinite(Date.parse(v))
}

/** Has the coach been told, and when (Dublin wall-clock). */
export function rosterChangeTold(change) {
  const c = change || {}
  if (!c.notified_at) return 'not told yet'
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

/** "Assigned Coach A to Tue 15 Sep 06:00 · told 14:02" */
export function formatRosterChange(change) {
  return `${rosterChangeSentence(change)} · ${rosterChangeTold(change)}`
}
