// TZ.8a — FROZEN copies of the rostering functions as they were before the
// sweep made them take the studio's zone. Test-only: the byte-identity tests
// in tz-8a.tz.test.js diff the new code (zone = 'Europe/Dublin') against
// these. Do not edit; TZ.18b deletes this file.
import { dublinDayStr, dublinTimeLabel, addDaysISO } from '@/lib/dublin-time'
import { effectiveShiftStart, effectiveShiftEnd } from '@shared/roster-month'

// ── src/lib/staff-push-hours.js ────────────────────────────────────────────
const STAFF_PUSH_DEFAULT_TZ = 'Europe/Dublin'
const STAFF_PUSH_FROM = '07:00'   // inclusive
const STAFF_PUSH_UNTIL = '22:00'  // exclusive

// One cached Intl.DateTimeFormat per timezone string, the way push-reminders'
// localToUtc caches its own: constructing one is the expensive part of a
// wall-clock read, and a cron asks about the same handful of zones every tick.
// An INVALID zone is remembered as null, so it is only ever tried once. Keys
// are strings no longer than any IANA name; anything else never reaches it.
const MAX_TZ_LENGTH = 64
const wallClockFormatters = new Map()
function wallClockFormatterFor(tz) {
  if (!wallClockFormatters.has(tz)) {
    let fmt = null
    try {
      // hourCycle h23: midnight is "00", never "24".
      fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    } catch {
      fmt = null // not a zone Intl knows (a RangeError)
    }
    wallClockFormatters.set(tz, fmt)
  }
  return wallClockFormatters.get(tz)
}

/** Is this a timezone string Intl accepts? Empty, blank and non-strings are not. Never throws. */
function isValidStaffTimeZoneLegacy(tz) {
  if (typeof tz !== 'string' || tz.trim() === '' || tz.length > MAX_TZ_LENGTH) return false
  return !!wallClockFormatterFor(tz)
}

/**
 * The zone a studio's clock is read in, with the fallback. Never throws.
 *   valid            -> as written,     warn: false
 *   null / undefined -> Europe/Dublin,  warn: false  (never set: the default)
 *   anything else    -> Europe/Dublin,  warn: true   (the caller logs ONE warning)
 *
 * @returns {{ timeZone: string, warn: boolean }}
 */
export function resolveStaffTimeZoneLegacy(tz) {
  if (isValidStaffTimeZoneLegacy(tz)) return { timeZone: tz, warn: false }
  return { timeZone: STAFF_PUSH_DEFAULT_TZ, warn: tz != null }
}

/** 'HH:MM' on the h23 wall clock at `tz` (fallback applied); null for an unreadable instant. */
export function staffWallClockHHMMLegacy(ms, tz = STAFF_PUSH_DEFAULT_TZ) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null
  const parts = wallClockFormatterFor(resolveStaffTimeZoneLegacy(tz).timeZone).formatToParts(new Date(ms))
  const get = (type) => parts.find((p) => p.type === type)?.value
  return `${get('hour')}:${get('minute')}`
}

export function inStaffPushHoursLegacy(nowMs, tz = STAFF_PUSH_DEFAULT_TZ) {
  const wall = staffWallClockHHMMLegacy(nowMs, tz)
  return wall != null && wall >= STAFF_PUSH_FROM && wall < STAFF_PUSH_UNTIL
}

// ── src/lib/block-edit.js ──────────────────────────────────────────────────
function toHms(t) {
  if (typeof t !== 'string') return null
  if (/^\d{2}:\d{2}$/.test(t)) return `${t}:00`
  if (/^\d{2}:\d{2}:\d{2}/.test(t)) return t.slice(0, 8)
  return null
}
const TOO_LATE_BEFORE = '07:30'
export function blockEditNoticeWhenLegacyDublin({ nowMs, timeZone, blockDate, windows = [] }) {
  if (inStaffPushHoursLegacy(nowMs, timeZone)) return 'shortly'
  const wall = staffWallClockHHMMLegacy(nowMs, timeZone) || '00:00'
  const today = dublinDayStr(nowMs)
  const noticeDay = wall < STAFF_PUSH_FROM ? today : addDaysISO(today, 1)
  const early = windows.some((w) => [w.from?.start_time, w.to?.start_time]
    .some((t) => toHms(t) !== null && toHms(t).slice(0, 5) < TOO_LATE_BEFORE))
  return blockDate === noticeDay && early ? 'too_late' : 'morning'
}
export function coachShiftOverLegacyDublin({ blockDate, from, to, nowMs, timeZone }) {
  const today = dublinDayStr(nowMs)
  if (blockDate < today) return true
  if (blockDate > today) return false
  const now = staffWallClockHHMMLegacy(nowMs, timeZone)
  const ends = [from?.end_time, to?.end_time].map(toHms).filter(Boolean).map((t) => t.slice(0, 5))
  if (!now || ends.length === 0) return false
  return ends.every((e) => e <= now)
}

// ── src/lib/roster-change-format.js ────────────────────────────────────────
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const OWN_STAMP_WINDOW_MS = 10 * 60 * 1000
const NO_MESSAGE_REASONS = Object.freeze(['staff_permanent_delete', 'replace_undone', 'replace_shift_started', 'replace_shift_deleted'])
function dateParts(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) } : null
}
function shortDate(iso) {
  const p = dateParts(iso)
  return p ? `${p.d} ${MONTHS[p.mo - 1]}` : ''
}
function isInstant(v) {
  return Boolean(v) && Number.isFinite(Date.parse(v))
}
function isDeliveredTimeEdit(c, d) {
  if (c.action !== 'time_changed' || !('start_time_override' in d) || !('end_time_override' in d)) return false
  if (!isInstant(c.notified_at) || !isInstant(c.created_at)) return false
  const gap = Date.parse(c.notified_at) - Date.parse(c.created_at)
  return gap >= 0 && gap <= OWN_STAMP_WINDOW_MS
}
export function stampMeansToldLegacyDublin(change) {
  const c = change || {}
  const d = c.details || {}
  if (NO_MESSAGE_REASONS.includes(d.reason)) return false
  if (c.action === 'block_edited') return false
  if (d.notice === 'not_needed') return false
  if (d.via === 'swap_drop' && 'roster_status' in d && d.roster_status !== 'published') return false
  if (isDeliveredTimeEdit(c, d)) return true
  if (c.self_change === true) return false
  // 'YYYY-MM-DD' strings compare correctly as text. The stamp's day is the
  // DUBLIN day, which is the "today" every writer judged "past" against.
  if (dateParts(c.block_date) && isInstant(c.notified_at) && String(c.block_date).slice(0, 10) < dublinDayStr(c.notified_at)) return false
  return true
}
export function rosterChangeToldLegacyDublin(change) {
  const c = change || {}
  if (!c.notified_at) return 'not told yet'
  if (!stampMeansToldLegacyDublin(c)) return null
  if (!isInstant(c.notified_at)) return 'told'
  const time = dublinTimeLabel(c.notified_at)
  const toldDay = dublinDayStr(c.notified_at)
  // The day is only worth naming when it is not the day of the change.
  const sameDay = isInstant(c.created_at) && dublinDayStr(c.created_at) === toldDay
  return sameDay ? `told ${time}` : `told ${shortDate(toldDay)} ${time}`
}
export function rosterChangeBylineLegacyDublin(change) {
  const c = change || {}
  const who = c.actor_name || 'System'
  if (!isInstant(c.created_at)) return who
  return `${who} · ${shortDate(dublinDayStr(c.created_at))} ${dublinTimeLabel(c.created_at)}`
}

// ── src/lib/roster-compare-format.js ───────────────────────────────────────
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
function dayLabel(dateIso) {
  const m = String(dateIso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return ''
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  return `${DAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()]} ${d} ${MONTHS[mo - 1]}`
}
const DUBLIN_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})
function dublinParts(iso) {
  const ms = Date.parse(iso || '')
  if (!Number.isFinite(ms)) return null
  const p = {}
  for (const { type, value } of DUBLIN_PARTS.formatToParts(new Date(ms))) p[type] = value
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` }
}
export function publishedLabelLegacyDublin(iso) {
  const p = dublinParts(iso)
  return p ? `${dayLabel(p.date)}, ${p.time}` : ''
}
export function missingSnapshotMessageLegacyDublin({ missing_reason: reason, snapshots_began_at: beganAt } = {}) {
  if (reason === 'outside_window') {
    return 'This publish does not cover the days on screen, so there is nothing to compare here.'
  }
  if (reason === 'not_saved') {
    return 'The record of this publish could not be saved at the time, so there is nothing to compare it with. The next publish of this period will be recorded.'
  }
  const began = dublinParts(beganAt)
  if (began) {
    return `Published vs now is available for rosters published from ${dayLabel(began.date)}. This roster was published before then.`
  }
  return 'Published vs now starts with the next publish at this studio. Rosters published before it have no record of what was published.'
}

// ── src/lib/shift-reminders.js ─────────────────────────────────────────────
const BODY_MAX_CHARS = 140
const MAX_CO_NAMES = 3
const hhmm = (t) => String(t || '').slice(0, 5)
const minutesOfDay = (t) => { const [h, m] = hhmm(t).split(':').map(Number); return h * 60 + m }
function joinNames(names) {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
function coNamesLabel(names, shown) {
  if (shown >= names.length) return joinNames(names)
  return `${names.slice(0, shown).join(', ')} +${names.length - shown} more`
}
function latestEndLabel(run) {
  let best = null
  for (const s of run) {
    const start = effectiveShiftStart(s)
    const end = effectiveShiftEnd(s)
    if (!start || !end) continue
    let mins = minutesOfDay(end)
    if (mins < minutesOfDay(start)) mins += 24 * 60
    if (!best || mins > best.mins) best = { mins, label: hhmm(end) }
  }
  return best?.label || ''
}
export function buildShiftReminderMessageLegacyDublin({ run, nameByLocation = {}, coNames = [], nowMs }) {
  const first = run[0]
  const start = hhmm(effectiveShiftStart(first))
  const end = latestEndLabel(run)
  const today = dublinDayStr(nowMs)
  const dayWord = first.shift_date === today
    ? 'today'
    : first.shift_date === addDaysISO(today, 1) ? 'tomorrow' : `on ${first.shift_date}`

  const studios = []
  for (const s of run) {
    const n = nameByLocation[s.location_id]
    if (n && !studios.includes(n)) studios.push(n)
  }
  const shiftNames = run.map((s) => s.shift_templates?.name).filter(Boolean)

  let head = `${dayWord[0].toUpperCase()}${dayWord.slice(1)} ${start}`
  if (end) head += ` to ${end}`
  if (studios.length) head += ` at ${joinNames(studios)}`
  const compose = (shownShifts, shownCo) => {
    const hidden = shiftNames.length - shownShifts
    const names = shiftNames.length ? `: ${shiftNames.slice(0, shownShifts).join(', ')}${hidden ? ` +${hidden} more` : ''}` : ''
    const tail = shownCo > 0 ? ` · with ${coNamesLabel(coNames, shownCo)}` : ''
    return head + names + tail
  }
  // BODY_MAX_CHARS is a HARD cap. What gives way, in order: shift names (down
  // to one), then colleagues (down to none), then an ellipsis. The day, times
  // and studio lead the body so they are the last thing an ellipsis can reach.
  let shownShifts = shiftNames.length
  let shownCo = Math.min(coNames.length, MAX_CO_NAMES)
  while (shownShifts > 1 && compose(shownShifts, shownCo).length > BODY_MAX_CHARS) shownShifts--
  while (shownCo > 0 && compose(shownShifts, shownCo).length > BODY_MAX_CHARS) shownCo--
  let body = compose(shownShifts, shownCo)
  if (body.length > BODY_MAX_CHARS) body = `${body.slice(0, BODY_MAX_CHARS - 1).trimEnd()}…`

  const title = run.length > 1 ? `${run.length} shifts ${dayWord} from ${start}` : `Shift ${dayWord} at ${start}`
  return { title, body }
}
