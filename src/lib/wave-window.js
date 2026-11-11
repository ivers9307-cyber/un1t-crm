// WAVEWIN.1 — sequential wave fill for the public signup widget.
//
// Events with waves across many hours fill sparsely when every wave is
// offered at once: customers scatter across the day and part-filled
// waves end up separated by big gaps. The public picker instead offers
// only the immediately-available window:
//
//   - anchor = the earliest wave that still has space
//   - visible = every wave starting at or before anchor + windowMinutes
//   - earlier sold-out waves stay visible (the picker already greys
//     them) so the fill progress is legible
//   - later waves are hidden, and "release" automatically as earlier
//     waves fill and the anchor slides forward
//
// Display-only policy: the register API still accepts any wave id, and
// the operator surfaces (RaceControlPanel etc.) always see every wave.
//
// WAVEWIN.2 — the window length is the event's own setting
// (race_events.wave_window_minutes, mig 825), chosen on the staff event
// form. NULL = WAVE_WINDOW_MINUTES. Waves are same-day, so a whole-day
// window (WAVE_WINDOW_ALL_MINUTES) is "every start time at once".

export const WAVE_WINDOW_MINUTES = 90
// The range the column's CHECK accepts (mig 825) — keep the three in step
// (tests/migration-825-wave-window.test.js runs the migration against them).
export const WAVE_WINDOW_MIN_MINUTES = 15
export const WAVE_WINDOW_ALL_MINUTES = 1440
// What the event form offers, default first.
export const WAVE_WINDOW_CHOICES = Object.freeze([WAVE_WINDOW_MINUTES, 120, 180, 240, 360, WAVE_WINDOW_ALL_MINUTES])

/**
 * The release window for an event, in minutes. Anything but a whole number
 * inside the column's range (a missing column, NULL, a hand-edited value)
 * falls back to the default — the picker must never lose its waves to a bad
 * setting.
 * @param {{ wave_window_minutes?: number|null }|null|undefined} event
 */
export function resolveWaveWindowMinutes(event) {
  const n = event?.wave_window_minutes
  if (typeof n !== 'number' || !Number.isInteger(n)) return WAVE_WINDOW_MINUTES
  if (n < WAVE_WINDOW_MIN_MINUTES || n > WAVE_WINDOW_ALL_MINUTES) return WAVE_WINDOW_MINUTES
  return n
}

/** "90 minutes" / "2 hours" / "2 hours 30 minutes" / "the whole day". */
export function waveWindowLabel(minutes) {
  if (minutes >= WAVE_WINDOW_ALL_MINUTES) return 'the whole day'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (m === 0 && h > 0) return h === 1 ? '1 hour' : `${h} hours`
  if (minutes < 120) return `${minutes} minutes`
  return `${h} hours ${m} minutes`
}

// 'HH:MM' / 'HH:MM:SS' wall-clock → minutes since midnight, or null.
// Waves are same-day (race_date), so plain minute arithmetic is safe —
// no Date construction, no timezone exposure.
function waveMinutes(w) {
  const m = (w?.start_time || '').match(/^(\d{1,2}):(\d{2})/)
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/**
 * Filter the public wave list down to the immediately-available window.
 * Preserves the incoming order. Fails open: a wave with no parsable
 * start_time is never hidden, and when nothing has space (or nothing is
 * parsable) the full list comes back unchanged.
 *
 * @param {Array<{start_time?: string|null, is_full?: boolean}>} waves
 * @param {number} windowMinutes
 */
export function windowedWaves(waves, windowMinutes = WAVE_WINDOW_MINUTES) {
  const arr = Array.isArray(waves) ? waves : []
  let anchor = null
  for (const w of arr) {
    if (w?.is_full) continue
    const t = waveMinutes(w)
    if (t != null && (anchor == null || t < anchor)) anchor = t
  }
  if (anchor == null) return arr
  const closesAt = anchor + windowMinutes
  return arr.filter((w) => {
    const t = waveMinutes(w)
    if (t == null) return true
    return t <= closesAt
  })
}
