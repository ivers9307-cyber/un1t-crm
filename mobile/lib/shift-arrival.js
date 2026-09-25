// mobile/lib/shift-arrival.js
//
// ARRIVALSHOW.1 — the one line under a coach's OWN shift on the Schedule tab
// (Me view): what the app recorded as their arrival. Pure, no React, no Intl:
// the server (src/lib/shift-arrivals.js, via GET /api/schedule/shifts) sends
// the facts, including the studio-local HH:MM, so a Hermes build without ICU
// and a phone set to another zone both read it right. This file only compares
// "now" with two instants and picks words.
//
// Unknown is never absence: no `arrival` (an old server), null (a colleague's
// row, or a failed read), or tracked !== true all show NOTHING about a
// missing arrival. A stored stamp is always shown.
//
// Words are neutral on purpose (late/no-show alerts are held, 00-INDEX): the
// time, never minutes late, never "missed". Tone classes live in
// components/schedule/ArrivalLine.jsx (NativeWind does not scan mobile/lib).

export const ARRIVAL_WORDS = Object.freeze({
  arrived: (hhmm) => `Arrived ${hhmm}`,
  arrivedDayBefore: (hhmm) => `Arrived ${hhmm} the day before`,
  onSite: (hhmm) => `On site from your earlier shift (arrived ${hhmm})`,
  notYet: 'No arrival recorded yet',
  notRecorded: 'No arrival recorded',
  help: "Arrival times come from your phone's location when you reach the studio. They don't change your hours.",
})

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * @param {object|null} shift  a GET /api/schedule/shifts row
 * @param {number} nowMs       Date.now() at render
 * @returns {{ kind: 'arrived'|'on_site'|'not_yet'|'not_recorded', text: string } | null}
 */
export function arrivalLine(shift, nowMs) {
  const a = shift?.arrival
  if (!a || typeof a !== 'object') return null

  if (typeof a.at_local === 'string' && HHMM.test(a.at_local)) {
    if (a.carried === true) return { kind: 'on_site', text: ARRIVAL_WORDS.onSite(a.at_local) }
    const dayBefore = DATE.test(a.at_local_date || '') && DATE.test(shift.shift_date || '') && a.at_local_date < shift.shift_date
    return { kind: 'arrived', text: dayBefore ? ARRIVAL_WORDS.arrivedDayBefore(a.at_local) : ARRIVAL_WORDS.arrived(a.at_local) }
  }
  // A stamp exists but its local time is unreadable: there IS an arrival, so
  // saying "No arrival recorded" would be false. Say nothing.
  if (a.at != null) return null

  // No stamp: say so only where arrivals are really tracked, on a published
  // shift, once it has started.
  if (a.tracked !== true || shift.published === false) return null
  const starts = Date.parse(a.starts_at ?? '')
  const ends = Date.parse(a.ends_at ?? '')
  if (!Number.isFinite(starts) || !Number.isFinite(ends) || !Number.isFinite(nowMs)) return null
  if (nowMs < starts) return null
  if (nowMs < ends) return { kind: 'not_yet', text: ARRIVAL_WORDS.notYet }
  return { kind: 'not_recorded', text: ARRIVAL_WORDS.notRecorded }
}

/** The help line under the Me list: shown only when some line shows. */
export function arrivalHelpFor(shifts, nowMs) {
  for (const s of Array.isArray(shifts) ? shifts : []) {
    if (arrivalLine(s, nowMs)) return ARRIVAL_WORDS.help
  }
  return null
}
