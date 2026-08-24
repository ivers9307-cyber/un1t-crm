// WAVEGEN.1 — bulk wave generation for the staff race editor.
//
// Race days often run waves at a tight cadence over hours (e.g. every
// 7 minutes from 10:00 to 14:00) — far too many rows to hand-enter one
// at a time. The editor's generator takes start, end, interval and a
// per-wave capacity and populates the wave list; the rows stay
// individually editable afterwards.

// Hard ceiling on a single generation, so a typo (1-minute interval
// over 12 hours) can't flood the form or the race_waves table.
export const MAX_GENERATED_WAVES = 200

function toMinutes(hhmm) {
  const m = (hhmm || '').match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

function toHHMM(minutes) {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0')
  const m = String(minutes % 60).padStart(2, '0')
  return `${h}:${m}`
}

/**
 * Generate 'HH:MM' start times from `start` to `end` inclusive, every
 * `everyMinutes`. Returns [] for anything unusable (bad times, end
 * before start, interval < 1) rather than throwing — the form disables
 * its Generate button on [] and shows nothing scary.
 *
 * @param {string} start 'HH:MM'
 * @param {string} end 'HH:MM'
 * @param {number|string} everyMinutes
 * @returns {string[]}
 */
export function generateWaveTimes(start, end, everyMinutes) {
  const s = toMinutes(start)
  const e = toMinutes(end)
  const step = Number(everyMinutes)
  if (s == null || e == null || !Number.isInteger(step) || step < 1 || e < s) return []
  const times = []
  for (let t = s; t <= e && times.length < MAX_GENERATED_WAVES; t += step) {
    times.push(toHHMM(t))
  }
  return times
}
