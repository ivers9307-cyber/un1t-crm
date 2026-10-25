// EVENT-MULTITIME.1 — start-time choices on the public event page.
//
// Every event stores its start times as race_waves rows. Races have always
// offered several (the wave picker, windowed by WAVEWIN.1); non-race kinds
// used to be locked to one synthetic wave. They can now carry several too
// (e.g. an 8am and a 9am class on one page), and these helpers decide what
// the public widget shows for each kind:
//
//   - race: the wave picker, limited to the 90-minute release window
//   - lead_gen: never a picker (no date, no time)
//   - any other kind: a plain time picker when there are 2+ times, every
//     time shown (no release window — a class at 8am and 6pm both show),
//     full ones greyed by the widget

import { isRaceKind } from '@shared/events'
import { windowedWaves } from '@/lib/wave-window'

const hhmm = (t) => (typeof t === 'string' ? t.slice(0, 5) : '')

/** Waves the public picker offers; [] = no picker. */
export function timePickerWaves(kind, waves) {
  const arr = Array.isArray(waves) ? waves : []
  if (isRaceKind(kind)) return windowedWaves(arr)
  if (kind === 'lead_gen') return []
  return arr.length > 1 ? arr : []
}

/**
 * The wave to pre-select on load: the only one with space, else '' so the
 * customer has to choose (never silently book the first of two open times).
 */
export function initialWaveId(waves) {
  const available = (Array.isArray(waves) ? waves : []).filter((w) => !w.is_full)
  return available.length === 1 ? available[0].id : ''
}

/** Customer-facing label for the start-time row. */
export function timeRowLabel(kind) {
  return isRaceKind(kind) ? 'Wave' : 'Time'
}

/** "08:00 or 09:00" / "08:00, 09:00 or 10:30" — sorted, blanks skipped. */
export function formatTimeChoices(waves) {
  const times = (Array.isArray(waves) ? waves : [])
    .map((w) => hhmm(w?.start_time))
    .filter(Boolean)
    .sort()
  if (times.length <= 1) return times[0] || ''
  return `${times.slice(0, -1).join(', ')} or ${times[times.length - 1]}`
}
