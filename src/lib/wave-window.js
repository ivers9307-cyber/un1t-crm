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
// The window length is a product constant for now — make it a
// race_events column if an event ever needs a different one.

export const WAVE_WINDOW_MINUTES = 90

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
