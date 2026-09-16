// Pure helpers for the zero-touch attendance feature (Phase 1 of
// "who turned up on time" tracking).
//
// What lives here:
//   resolveScheduledAt(blockDate, startTime, tz)
//     → combines a date + time stored in the schedule with the
//       location's IANA timezone to produce a real UTC instant.
//       DST-correct via Intl.DateTimeFormat — no dependency on
//       date-fns-tz.
//
//   bucketLateness(scheduledAt, arrivalAt, opts)
//     → 'on_time' | 'late' | 'no_show', honouring a configurable
//       grace window (default 60s — Stillorgan's policy).
//
//   decideGeofenceStamp(eventAt, shifts, opts)
//     → what one geofence ping should do: stamp a shift's arrival,
//       report it already arrived, treat it as a re-entry, or nothing.
//       ARRIVAL.1 — the result lands on shift_assignments.arrived_at,
//       never on the paid window.
//
//   inferContinuousArrivals(rows, opts)
//     → report-time: carries an arrival onto back-to-back shifts the
//       coach was already on site for (a re-entry stamps nothing).
//
// What does NOT live here:
//   - Any DB query. The webhook receiver loads the candidate shifts
//     and passes them in. Keeps the file pure + testable.
//
// Late policy at Stillorgan (operator decision, May 2026):
//   - Any arrival > scheduled_start + 60s = late
//   - 60s grace covers card-tap-on-the-second wobble
//   - No-show classification is done at REPORT time (when the
//     shift end is in the past and no arrival is recorded)

const MS_PER_MIN = 60 * 1000
const DEFAULT_GRACE_MS = 60 * 1000          // 1 min

// ── Timezone-aware date math ──────────────────────────────────

/**
 * Combine a calendar date + time-of-day + IANA timezone into a UTC
 * instant. Handles DST correctly: a 06:00 shift in Dublin lands on
 * 06:00 BST in summer (UTC+1) and 06:00 GMT in winter (UTC+0).
 *
 * The technique: build a guess UTC instant treating the local time
 * AS IF it were UTC, then ask Intl.DateTimeFormat what that instant
 * looks like in the target timezone, and use the discrepancy as the
 * offset. This is the standard offset-detection pattern that
 * survives DST without needing the IANA tz database client-side.
 *
 * @param {string} dateStr   YYYY-MM-DD (Postgres `date` columns)
 * @param {string} timeStr   HH:MM[:SS] (Postgres `time` columns)
 * @param {string} tz        IANA zone, e.g. 'Europe/Dublin'
 * @returns {Date}           UTC instant
 */
export function resolveScheduledAt(dateStr, timeStr, tz = 'UTC') {
  if (!dateStr || !timeStr) return null
  const [yy, mm, dd] = String(dateStr).split('-').map(Number)
  const [hh = 0, mi = 0, ss = 0] = String(timeStr).split(':').map(Number)
  if ([yy, mm, dd, hh, mi].some((n) => !Number.isFinite(n))) return null

  // Treat the wall clock values AS IF they were UTC — we'll fix the
  // offset in a moment.
  const guess = new Date(Date.UTC(yy, mm - 1, dd, hh, mi, ss))

  // What does that UTC instant look like in the target tz?
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  })
  const parts = Object.fromEntries(fmt.formatToParts(guess).map((p) => [p.type, p.value]))
  const tzY  = +parts.year
  const tzM  = +parts.month
  const tzD  = +parts.day
  // Intl reports midnight as '24' in some locales — normalise.
  const tzH  = (+parts.hour === 24) ? 0 : +parts.hour
  const tzMi = +parts.minute
  const tzS  = +parts.second

  const desiredUtc = Date.UTC(yy, mm - 1, dd, hh, mi, ss)
  const observedUtc = Date.UTC(tzY, tzM - 1, tzD, tzH, tzMi, tzS)
  const offsetMs = desiredUtc - observedUtc
  return new Date(guess.getTime() + offsetMs)
}

// ── Lateness bucketing ────────────────────────────────────────

/**
 * Classify an arrival vs. its scheduled start.
 *
 * @param {Date|string|null} scheduledAt
 * @param {Date|string|null} arrivalAt
 * @param {object}  [opts]
 * @param {number}  [opts.graceMs=60_000]  Anything inside the grace
 *                                          window after scheduled is
 *                                          still on_time. Stillorgan
 *                                          uses 60s.
 * @returns {'on_time'|'late'|'no_show'|'pending'}
 *   - on_time   : arrived ≤ scheduled + grace
 *   - late      : arrived > scheduled + grace
 *   - no_show   : never arrived AND scheduled_end is in the past
 *   - pending   : never arrived AND scheduled_end is still future
 */
export function bucketLateness(scheduledAt, arrivalAt, opts = {}) {
  const { graceMs = DEFAULT_GRACE_MS, scheduledEndAt = null, nowMs = Date.now() } = opts

  const arrivalMs = arrivalAt ? new Date(arrivalAt).getTime() : null
  const scheduledMs = scheduledAt ? new Date(scheduledAt).getTime() : null

  if (arrivalMs == null) {
    if (scheduledEndAt && new Date(scheduledEndAt).getTime() < nowMs) return 'no_show'
    return 'pending'
  }
  if (scheduledMs == null) return 'on_time' // safest fallback
  return (arrivalMs - scheduledMs) <= graceMs ? 'on_time' : 'late'
}

/**
 * How many whole minutes late was this arrival? Negative = early.
 * Returns null if either side is missing.
 */
export function minutesLate(scheduledAt, arrivalAt) {
  if (!scheduledAt || !arrivalAt) return null
  const diffMs = new Date(arrivalAt).getTime() - new Date(scheduledAt).getTime()
  return Math.round(diffMs / MS_PER_MIN)
}

// ── Decide what a geofence ping does ───────────────────────────

// ARRIVAL.1 (D-D) — an arrival may match a shift at most 45 minutes before it
// starts. The old symmetric ±4 h window let a 13:46 ping become the paid start
// of a 17:45 shift.
export const GEOFENCE_EARLY_WINDOW_MS = 45 * MS_PER_MIN
// Late matches are bounded by the shift's own end; this is the outer cap.
export const GEOFENCE_LATE_WINDOW_MS = 4 * 3600_000
// ARRIVAL.1 (D-E) — a ping while the coach is on a shift they already arrived
// for, or within this long after it ended, is a re-entry, not a new arrival.
export const GEOFENCE_REENTRY_GAP_MS = 60 * MS_PER_MIN

const toMs = (v) => (v == null ? NaN : new Date(v).getTime())

/**
 * Decide what one geofence ping does. Pure: the caller loads every live
 * shift for the coach at the location (±1 day) INCLUDING ones that already
 * have an arrival, because excluding them is what let a duplicate ping move
 * on to the coach's next shift (16 Sep review: 10 double-stamped pairs).
 *
 * @param {Date|string} eventAt
 * @param {Array<{id: string, scheduledAt: Date, scheduledEndAt: Date, arrivedAt: Date|null}>} shifts
 * @param {object} [opts]
 * @returns {{kind: 'stamp'|'already'|'reentry'|'none', shift: object|null}}
 */
export function decideGeofenceStamp(eventAt, shifts, opts = {}) {
  const {
    earlyMs = GEOFENCE_EARLY_WINDOW_MS,
    lateMs = GEOFENCE_LATE_WINDOW_MS,
    reentryGapMs = GEOFENCE_REENTRY_GAP_MS,
  } = opts
  const t = toMs(eventAt)
  if (!Number.isFinite(t) || !Array.isArray(shifts)) return { kind: 'none', shift: null }
  const valid = shifts.filter((s) => Number.isFinite(toMs(s?.scheduledAt)))

  const onSite = valid.find((s) => (
    s.arrivedAt
    && toMs(s.arrivedAt) <= t
    && Number.isFinite(toMs(s.scheduledEndAt))
    && t <= toMs(s.scheduledEndAt) + reentryGapMs
  ))
  if (onSite) return { kind: 'reentry', shift: onSite }

  let best = null
  for (const s of valid) {
    const start = toMs(s.scheduledAt)
    const end = toMs(s.scheduledEndAt)
    if (t < start - earlyMs) continue
    if (t > start + lateMs) continue
    if (Number.isFinite(end) && t > end) continue
    const delta = Math.abs(t - start)
    if (!best || delta < best.delta || (delta === best.delta && start < toMs(best.shift.scheduledAt))) {
      best = { shift: s, delta }
    }
  }
  if (!best) return { kind: 'none', shift: null }
  return best.shift.arrivedAt ? { kind: 'already', shift: best.shift } : { kind: 'stamp', shift: best.shift }
}

/**
 * Report-time: a shift with no recorded arrival inherits the arrival of the
 * same coach's previous shift that day when the gap between them is at most
 * `maxGapMs` (the coach was already on site; the re-entry stamped nothing).
 * Returns new objects in INPUT order, each with `arrivalInferred`.
 *
 * @param {Array<{profileId: string, blockDate: string, scheduledAt: Date, scheduledEndAt: Date, arrivalAt: Date|null}>} rows
 * @param {object} [opts]
 */
export function inferContinuousArrivals(rows, opts = {}) {
  const { maxGapMs = GEOFENCE_REENTRY_GAP_MS } = opts
  const out = (rows || []).map((r) => ({ ...r, arrivalInferred: false }))
  const ordered = [...out].sort((a, b) => (
    String(a.profileId).localeCompare(String(b.profileId))
    || String(a.blockDate).localeCompare(String(b.blockDate))
    || toMs(a.scheduledAt) - toMs(b.scheduledAt)
  ))
  let prev = null
  for (const r of ordered) {
    const sameRun = prev && prev.profileId === r.profileId && prev.blockDate === r.blockDate
    if (
      !r.arrivalAt
      && sameRun
      && prev.arrivalAt
      && Number.isFinite(toMs(prev.scheduledEndAt))
      && toMs(r.scheduledAt) - toMs(prev.scheduledEndAt) <= maxGapMs
    ) {
      r.arrivalAt = prev.arrivalAt
      r.arrivalInferred = true
    }
    prev = r
  }
  return out
}

/**
 * Convert a stamped arrival into a Postgres `time` literal — the
 * attendance report shows arrival as a wall-clock time, so we render
 * the wall-clock time in the location's timezone and persist that.
 */
export function arrivalToTimeOnly(arrivalAt, tz = 'UTC') {
  if (!arrivalAt) return null
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  })
  const parts = Object.fromEntries(fmt.formatToParts(new Date(arrivalAt)).map((p) => [p.type, p.value]))
  const hh = (+parts.hour === 24 ? 0 : +parts.hour).toString().padStart(2, '0')
  return `${hh}:${parts.minute}:${parts.second}`
}
