// Pure race-control timing helpers (mig 081 / 124). Shared by the web
// race control panel (src/lib/race-control.js re-exports these) and the
// mobile race-day control screen (mobile/app/races). Kept dependency-free
// (no logging, no db) so both platforms import the same source of truth —
// the IO helper ensureTeamForBooking stays web-only in src/lib.

/**
 * Format an elapsed-time number of seconds as HH:MM:SS.
 *
 *    0    -> "00:00"   59 -> "00:59"   60 -> "01:00"
 *    3599 -> "59:59"   3600 -> "1:00:00"   null -> "—"
 *
 * No hour component for sub-60-min times — keeps the race UI scannable.
 *
 * @param {number|null|undefined} seconds
 * @returns {string}
 */
export function formatElapsed(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—'
  const s = Math.floor(seconds)
  const hh = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const pad = (n) => String(n).padStart(2, '0')
  if (hh === 0) return `${pad(mm)}:${pad(ss)}`
  return `${hh}:${pad(mm)}:${pad(ss)}`
}

/**
 * Classify a registration/booking's race state into one of four buckets.
 *
 *   'next_up'   — confirmed, no race_started_at yet
 *   'on_course' — race_started_at set, race_finished_at not yet
 *   'completed' — both timestamps set
 *   'no_show'   — status is 'no_show' OR 'cancelled'
 *
 * @param {object} booking
 * @returns {'next_up' | 'on_course' | 'completed' | 'no_show'}
 */
export function classifyBookingState(booking) {
  if (!booking) return 'next_up'
  if (booking.status === 'no_show' || booking.status === 'cancelled') return 'no_show'
  if (booking.race_finished_at) return 'completed'
  if (booking.race_started_at) return 'on_course'
  return 'next_up'
}

/**
 * Elapsed seconds between two ISO timestamps. null if either is missing.
 * Negative clamps to 0 (defensive against clock skew / reset-then-start).
 *
 * @param {string|null|undefined} startIso
 * @param {string|null|undefined} endIso
 * @returns {number|null}
 */
export function elapsedSecondsBetween(startIso, endIso) {
  if (!startIso || !endIso) return null
  const ms = Date.parse(endIso) - Date.parse(startIso)
  if (!Number.isFinite(ms)) return null
  return Math.max(0, Math.floor(ms / 1000))
}

/**
 * Sum a registration's penalties[] (mig 124). Returns 0 (not null) for
 * missing/empty so callers can additively combine. Coerces non-numeric
 * entries to 0 — defensive against malformed payloads.
 *
 * @param {Array<{seconds:number}>|null|undefined} penalties
 * @returns {number}
 */
export function penaltySumSeconds(penalties) {
  if (!Array.isArray(penalties) || penalties.length === 0) return 0
  let total = 0
  for (const p of penalties) {
    const n = Number(p?.seconds)
    if (Number.isFinite(n)) total += n
  }
  return total
}

/**
 * Adjusted elapsed time: base elapsed + sum(penalties.seconds). null if the
 * base is unknowable (no start). For live "on course" rows pass nowIso as
 * endIso so penalties show before the team finishes. Negative clamps to 0.
 *
 * @param {string|null|undefined} startIso
 * @param {string|null|undefined} endIso
 * @param {Array<{seconds:number}>|null|undefined} penalties
 * @returns {number|null}
 */
export function elapsedWithPenalties(startIso, endIso, penalties) {
  const base = elapsedSecondsBetween(startIso, endIso)
  if (base == null) return null
  return Math.max(0, base + penaltySumSeconds(penalties))
}
