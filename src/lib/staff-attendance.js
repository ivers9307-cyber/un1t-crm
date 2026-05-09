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
//   matchArrivalToShift(arrivalAt, shifts, opts)
//     → given a list of un-stamped shifts already loaded by the
//       caller, picks the one whose scheduled start is closest to
//       the arrival within ±4h.
//
// What does NOT live here:
//   - Any DB query. The webhook receiver loads the candidate shifts
//     and passes them in. Keeps the file pure + testable.
//
// Late policy at Stillorgan (operator decision, May 2026):
//   - Any arrival > scheduled_start + 60s = late
//   - 60s grace covers card-tap-on-the-second wobble
//   - No-show classification is done at REPORT time (when the
//     shift end is in the past and start_time_override is still NULL)

const MS_PER_MIN = 60 * 1000
const DEFAULT_GRACE_MS = 60 * 1000          // 1 min
const DEFAULT_MATCH_WINDOW_MS = 4 * 3600_000 // 4 h either side of scheduled

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

// ── Match arrival event to a scheduled shift ──────────────────

/**
 * From a list of candidate shifts (the caller pre-loads them — this
 * function does no IO), pick the one most likely to be the shift
 * the arriving staff member is here for.
 *
 * "Most likely" = the shift whose scheduledAt is closest to the
 * arrival, within the match window. Ties broken by earliest
 * scheduledAt (mostly defensive — true ties are rare).
 *
 * Caller is responsible for pre-filtering to:
 *   - the right profile_id
 *   - the right location_id
 *   - shifts where start_time_override IS NULL (don't overwrite)
 *   - shifts within a sensible date band (today ± 1 day usually)
 *
 * @param {Date|string} arrivalAt
 * @param {Array<{id: string, scheduledAt: Date|string, scheduledEndAt?: Date|string}>} shifts
 * @param {object}  [opts]
 * @param {number}  [opts.windowMs=4h] How far either side of scheduled
 *                                      we accept the arrival. Bigger
 *                                      window = more permissive
 *                                      matching but more risk of
 *                                      attributing a 9am unlock to
 *                                      a 6am shift.
 * @returns {{shift: object, deltaMs: number} | null}
 */
export function matchArrivalToShift(arrivalAt, shifts, opts = {}) {
  const { windowMs = DEFAULT_MATCH_WINDOW_MS } = opts
  const arrivalMs = new Date(arrivalAt).getTime()
  if (!Number.isFinite(arrivalMs) || !Array.isArray(shifts) || shifts.length === 0) return null

  let best = null
  for (const s of shifts) {
    const schedMs = new Date(s.scheduledAt).getTime()
    if (!Number.isFinite(schedMs)) continue
    const deltaMs = Math.abs(arrivalMs - schedMs)
    if (deltaMs > windowMs) continue
    // Also skip if arrival is AFTER scheduled end — they're not
    // "arriving for" a shift that's already over.
    if (s.scheduledEndAt) {
      const endMs = new Date(s.scheduledEndAt).getTime()
      if (Number.isFinite(endMs) && arrivalMs > endMs) continue
    }
    if (!best || deltaMs < best.deltaMs ||
        (deltaMs === best.deltaMs && schedMs < new Date(best.shift.scheduledAt).getTime())) {
      best = { shift: s, deltaMs }
    }
  }
  return best
}

/**
 * Convert a stamped arrival into a Postgres `time` literal — the
 * column type on shift_assignments.start_time_override is `time
 * without time zone`, so we render the wall-clock time in the
 * location's timezone and persist that.
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
