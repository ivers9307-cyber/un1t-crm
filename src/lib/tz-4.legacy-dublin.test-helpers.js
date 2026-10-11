// TZ.4 — FROZEN copies of the send-time functions this task made zone-aware,
// copied verbatim from origin/main 1d425ef3. Bodies are unchanged; only the
// exported names gain a `Legacy` suffix, and private helpers travel with them.
// src/lib/tz-4.tz.test.js diffs the new code against these. Test-only:
// nothing in src/ imports this file. TZ.18b deletes it once the wave merges.

import { dublinDateKey, dublinAddDays, dublinDayStr } from './dublin-time'
import { normalizeQuietHours, isQuietHour } from './send-quiet-hours'

const DUBLIN_TZ = 'Europe/Dublin'
const HOUR_MS = 60 * 60 * 1000

// ── src/lib/send-quiet-hours.js ─────────────────────────────────────────────
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
export function nextAcceptableSendLegacy(candidate, config) {
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
export function evaluateSendTimeLegacy({ at, now, config } = {}) {
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

  const nextSlot = nextAcceptableSendLegacy(atMs, cfg)
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

// ── src/lib/sequences/scheduler.js ──────────────────────────────────────────
export function clampToSendWindowLegacy(candidate, window) {
  if (!window) return candidate
  const startH = Number.isFinite(window.start_hour) ? window.start_hour : null
  const endH = Number.isFinite(window.end_hour) ? window.end_hour : null
  const skipDays = Array.isArray(window.skip_days) ? window.skip_days.map(Number) : []
  if (startH == null && endH == null && skipDays.length === 0) return candidate

  // Iterate at most ~14 days forward — operators won't configure
  // an empty window in practice, but bound it defensively.
  let attempt = new Date(candidate.getTime())
  for (let i = 0; i < 14 * 24; i++) {
    // Use Intl to get the local hour + dow in Europe/Dublin without
    // fighting Date's local-tz coupling. getParts gives strings.
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Dublin',
      hour: 'numeric',
      hourCycle: 'h23',
      weekday: 'short',
    }).formatToParts(attempt)
    const hourStr = parts.find((p) => p.type === 'hour')?.value || '0'
    const dowStr = parts.find((p) => p.type === 'weekday')?.value || ''
    const localHour = Number(hourStr) || 0
    // Map en-GB short weekday to 0-6 (Sun=0).
    const DOW_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
    const localDow = DOW_MAP[dowStr] ?? 0

    const dayOk = !skipDays.includes(localDow)
    let hourOk = true
    if (startH != null && localHour < startH) hourOk = false
    if (endH != null && localHour >= endH) hourOk = false

    if (dayOk && hourOk) return attempt

    // Advance one hour at a time. Cheap loop bounded above.
    attempt = new Date(attempt.getTime() + 60 * 60_000)
  }
  // Fallback: return what we have rather than loop forever.
  return attempt
}

// ── src/lib/sequences/cron-triggers.js (runAnniversaryTriggers, inline) ─────
// Occurrence year (Dublin wall-clock) — part of the dedup ref.
export function anniversaryOccurrenceYearLegacy(now) {
  return dublinDayStr(now).slice(0, 4)
}
// The birthday target month-day: `days_after` days before today.
export function birthdayTargetMonthDayLegacy(now, daysAfter) {
  const targetDay = dublinDayStr(now - daysAfter * 24 * 3600_000)
  return targetDay.slice(5) // 'MM-DD'
}
