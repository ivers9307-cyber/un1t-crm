// GAPS-P4 — send-time quiet hours.
//
// WHY THIS EXISTS
// Across every campaign send at Stillorgan, 994 emails went out at 22:44 on a
// Saturday and another 179 at 21:36 on a Monday. Both campaigns had
// `scheduled_at IS NULL`: nobody mis-set a schedule, an operator pressed
// "Send now" late at night and nothing on the screen said what time it would
// land. Meanwhile 6,092 sends went out in the 20:00 hour and ~9,600 between
// 09:00 and 10:00 — the ordinary, uncontroversial slots.
//
// WHAT THIS IS NOT
// It is NOT a clamp. A manual send is a deliberate act; a send that quietly
// does not go out reads as a broken button and is worse than a late email.
// Nothing in this module defers, blocks or reschedules anything — it answers
// two questions for the UI:
//     "what Dublin wall clock does this land on, and is that inside the
//      operator-configured quiet window?"
//     "if it is, what is the next acceptable slot they could pick instead?"
// The send paths (campaign-sender.js and the broadcast crons) are untouched.
//
// EVERYTHING HERE IS PURE. `now` is always a parameter, never Date.now(), so
// the tests are deterministic and the same call can be made on the server.
//
// TIMEZONE POSTURE
// Europe/Dublin wall clock, resolved through Intl — the same approach as
// clampToSendWindow (src/lib/sequences/scheduler.js) and dublinDayStartMs
// (src/lib/dublin-time.js). No hand-rolled offset arithmetic: Dublin is UTC+1
// under IST and UTC+0 under GMT, the civil day is 23h or 25h long twice a
// year, and 01:00 does not exist at all on the spring-forward Sunday. Unlike
// clampToSendWindow's start/end comparison, this window WRAPS past midnight
// (21:00 → 08:00 is the default), which is handled explicitly below.

import { dublinDateKey, dublinAddDays } from './dublin-time'

const DUBLIN_TZ = 'Europe/Dublin'
const HOUR_MS = 60 * 60 * 1000

/**
 * The operator-editable default, mirrored by the column defaults in
 * migration 514. Both sides carry it so a location with no company_settings
 * row still gets quiet hours rather than silently getting none.
 *
 * 21:00 → 08:00 is chosen from the live data:
 *   • 22:00 (994 sends) and 21:00 (179) are the two hours we want flagged.
 *   • 20:00 carries 6,092 legitimate sends, so a window starting at 20:00
 *     would cry wolf on the single busiest evening hour and get ignored.
 *   • 08:00 is the earliest hour nobody would consider antisocial and it sits
 *     just ahead of the 09:00-10:00 block where ~9,600 sends already go out,
 *     so "schedule it for the morning instead" lands in the normal slot.
 */
export const DEFAULT_SEND_QUIET_HOURS = Object.freeze({
  enabled: true,
  startHour: 21,
  endHour: 8,
})

/** The company_settings column names (mig 514), in one place. */
export const QUIET_HOURS_COLUMNS = Object.freeze({
  enabled: 'send_quiet_hours_enabled',
  start: 'send_quiet_hours_start',
  end: 'send_quiet_hours_end',
})

// ─── config ───────────────────────────────────────────────────────

function hourOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  const h = Math.trunc(n)
  return h >= 0 && h <= 23 ? h : null
}

/**
 * Normalise a raw config into `{ enabled, startHour, endHour }`.
 *
 * Accepts the company_settings row shape (snake_case columns), the camelCase
 * shape the client hands back, or null/undefined for "no row at all". Every
 * field falls back INDEPENDENTLY to the default, so a half-written row can
 * never mean "no quiet hours".
 *
 * start === end is treated as DISABLED: a zero-length window cannot be
 * expressed with two hour boundaries, and reading it as a 24-hour window
 * would flag every send ever made.
 *
 * @param {object|null} raw
 * @returns {{ enabled: boolean, startHour: number, endHour: number }}
 */
export function normalizeQuietHours(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SEND_QUIET_HOURS }

  const rawEnabled = raw[QUIET_HOURS_COLUMNS.enabled] ?? raw.enabled
  const enabled = rawEnabled === null || rawEnabled === undefined
    ? DEFAULT_SEND_QUIET_HOURS.enabled
    : rawEnabled === true

  const startHour = hourOrNull(raw[QUIET_HOURS_COLUMNS.start] ?? raw.startHour)
    ?? DEFAULT_SEND_QUIET_HOURS.startHour
  const endHour = hourOrNull(raw[QUIET_HOURS_COLUMNS.end] ?? raw.endHour)
    ?? DEFAULT_SEND_QUIET_HOURS.endHour

  return { enabled: enabled && startHour !== endHour, startHour, endHour }
}

/**
 * Is `hour` (0-23, Europe/Dublin wall clock) inside the quiet window?
 *
 * THE WRAP. The window is half-open [startHour, endHour): the start hour is
 * quiet, the end hour is the first hour that is not. When startHour > endHour
 * the window crosses midnight, so membership is the UNION of the two arms
 * rather than the intersection — this is exactly where copying
 * clampToSendWindow's `h < start || h >= end` comparison would be wrong.
 *
 * @param {number} hour
 * @param {object} config  raw or normalised
 */
export function isQuietHour(hour, config) {
  const { enabled, startHour, endHour } = normalizeQuietHours(config)
  if (!enabled) return false
  const h = Number(hour)
  if (!Number.isFinite(h)) return false
  return startHour > endHour
    ? (h >= startHour || h < endHour)   // wraps midnight
    : (h >= startHour && h < endHour)   // ordinary same-day window
}

// ─── Dublin wall clock, via Intl ──────────────────────────────────

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: DUBLIN_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
})

function dublinParts(ms) {
  const p = {}
  for (const { type, value } of partsFmt.formatToParts(new Date(ms))) p[type] = value
  // 'en-GB' emits hour '24' at midnight; normalise to 0.
  const hour = p.hour === '24' ? 0 : Number(p.hour)
  return {
    y: Number(p.year), mo: Number(p.month), d: Number(p.day),
    h: hour, mi: Number(p.minute), s: Number(p.second),
  }
}

/** Europe/Dublin wall-clock hour (0-23) at a UTC instant. */
function dublinHour(ms) {
  return dublinParts(ms).h
}

/**
 * How far Dublin's wall clock is ahead of UTC at a given instant, in ms
 * (+1h under IST, 0 under GMT). Derived from what Intl actually reports, so
 * it is right on both sides of every transition without a rules table.
 */
function dublinOffsetMs(ms) {
  const p = dublinParts(ms)
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - ms
}

/**
 * UTC instant of `hour:00` Europe/Dublin local time on the given calendar day.
 *
 * Two-pass correction (same shape as dublinDayStartMs): guess the instant as
 * if the wanted wall clock were UTC, measure the real offset there, correct,
 * then re-measure at the corrected instant in case the first guess sat on the
 * far side of a transition. Callers must still verify the result — on the
 * spring-forward Sunday there is no 01:00 at all, and no arithmetic can
 * conjure an instant that does not exist.
 */
function dublinWallClockMs(dayKey, hour) {
  const [y, mo, d] = String(dayKey).split('-').map(Number)
  const guess = Date.UTC(y, mo - 1, d, hour, 0, 0)
  const firstPass = guess - dublinOffsetMs(guess)
  return guess - dublinOffsetMs(firstPass)
}

// ─── the two questions the UI asks ────────────────────────────────

function toMs(value) {
  if (value === null || value === undefined) return NaN
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  return Date.parse(value)
}

/**
 * The next instant at or after `candidate` that is outside the quiet window,
 * snapped to the top of the hour the window ends on (Dublin local).
 *
 * Returns a Date equal to `candidate` when quiet hours are off or the
 * candidate is already acceptable — the caller can always use the result.
 *
 * @param {Date|number|string} candidate
 * @param {object} config
 * @returns {Date}
 */
export function nextAcceptableSend(candidate, config) {
  const cfg = normalizeQuietHours(config)
  const t = toMs(candidate)
  if (!Number.isFinite(t)) return new Date(NaN)
  if (!cfg.enabled || !isQuietHour(dublinHour(t), cfg)) return new Date(t)

  // Try today's end-of-window slot, then the following days. Two iterations
  // would do; three is defensive and still bounded.
  let dayKey = dublinDateKey(t)
  for (let day = 0; day < 3; day++) {
    let slot = dublinWallClockMs(dayKey, cfg.endHour)
    // The nominal slot may not exist (spring-forward gap) or may still be
    // inside the window if the operator configured an odd pair — step whole
    // hours until it is genuinely acceptable. Whole-hour steps keep the
    // minutes at :00 because Dublin's transitions are whole hours.
    for (let i = 0; i < 24 && isQuietHour(dublinHour(slot), cfg); i++) slot += HOUR_MS
    if (slot > t && !isQuietHour(dublinHour(slot), cfg)) return new Date(slot)
    dayKey = dublinAddDays(dayKey, 1)
  }
  // Unreachable for any config the CHECK constraint allows; return the
  // candidate rather than loop, so the UI degrades to "no suggestion".
  return new Date(t)
}

const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: DUBLIN_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
})
const dateFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: DUBLIN_TZ, weekday: 'short', day: 'numeric', month: 'short',
})

/** Europe/Dublin wall clock as 'HH:MM'. */
function timeLabelOf(ms) {
  return timeFmt.format(new Date(ms)).replace(/^24:/, '00:')
}

/**
 * '22:44 tonight' / '08:00 tomorrow' / '23:00 on Wed 12 Aug'.
 * Relative wording only when it is unambiguous; anything past tomorrow spells
 * the date out. "tonight" is reserved for the evening of the current Dublin
 * day, which is precisely the case this feature exists for.
 */
function whenLabelOf(ms, nowMs) {
  const time = timeLabelOf(ms)
  const dayKey = dublinDateKey(ms)
  const todayKey = dublinDateKey(nowMs)
  if (dayKey === todayKey) return `${time} ${dublinHour(ms) >= 18 ? 'tonight' : 'today'}`
  if (dayKey === dublinAddDays(todayKey, 1)) return `${time} tomorrow`
  return `${time} on ${dateFmt.format(new Date(ms))}`
}

/**
 * Everything the composer needs to render the advisory, in one call.
 *
 * @param {object}  args
 * @param {Date|number|string|null} args.at    the resolved send instant
 *                                             ("now" for a send-now click,
 *                                             the picked time for a schedule)
 * @param {Date|number|string}      args.now   reference instant for the
 *                                             relative wording (required —
 *                                             this module never reads a clock)
 * @param {object|null}             args.config  company_settings row / camelCase
 * @returns {{
 *   enabled: boolean, quiet: boolean,
 *   timeLabel: string|null, whenLabel: string|null, windowLabel: string,
 *   nextSlot: Date|null, nextSlotIso: string|null, nextSlotLabel: string|null,
 * }}
 */
export function evaluateSendTime({ at, now, config } = {}) {
  const cfg = normalizeQuietHours(config)
  const windowLabel = `${String(cfg.startHour).padStart(2, '0')}:00 to ${String(cfg.endHour).padStart(2, '0')}:00`
  const inert = {
    enabled: cfg.enabled,
    quiet: false,
    timeLabel: null,
    whenLabel: null,
    windowLabel,
    nextSlot: null,
    nextSlotIso: null,
    nextSlotLabel: null,
  }

  const atMs = toMs(at)
  if (!Number.isFinite(atMs)) return inert

  const nowMs = Number.isFinite(toMs(now)) ? toMs(now) : atMs
  const timeLabel = timeLabelOf(atMs)
  const whenLabel = whenLabelOf(atMs, nowMs)

  if (!cfg.enabled || !isQuietHour(dublinHour(atMs), cfg)) {
    return { ...inert, timeLabel, whenLabel }
  }

  const nextSlot = nextAcceptableSend(atMs, cfg)
  const slotMs = nextSlot.getTime()
  return {
    enabled: true,
    quiet: true,
    timeLabel,
    whenLabel,
    windowLabel,
    nextSlot,
    nextSlotIso: nextSlot.toISOString(),
    nextSlotLabel: whenLabelOf(slotMs, nowMs),
  }
}
