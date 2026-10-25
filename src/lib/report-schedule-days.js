// ROSTER-FIX.5 — the one place the scheduled-report weekday convention is
// converted.
//
// Two conventions meet here and they are off by one:
//   • the UI presents a Monday-first week (index 0 = Monday), because that is
//     how every other schedule surface in the CRM reads;
//   • scheduled_reports.day_of_week is consumed by calculateNextRun() as
//     `(day_of_week - now.getDay() + 7) % 7`, which is JS's convention
//     (0 = Sunday) and always has been.
//
// The UI used to write its display index straight into the column, so a
// report scheduled for "Monday" stored 0, which the scheduler read as Sunday
// and ran a day early — every week, silently, for every weekly and
// fortnightly schedule. The stored value is now JS's weekday (mig 601 rotates
// the existing rows and records the convention on the column), and these two
// functions are the ONLY conversion. Keep them pure so the mapping is pinned
// by tests rather than by whichever component reads it next.

/** Display order for the weekday picker. Index = the "Monday-first" index. */
export const DAY_NAMES_MONDAY_FIRST = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
]

/**
 * Monday-first display index (0=Mon..6=Sun) → JS weekday (0=Sun..6=Sat).
 * This is what gets STORED.
 */
export function toJsDay(index) {
  return (index + 1) % 7
}

/**
 * JS weekday (0=Sun..6=Sat) → Monday-first display index (0=Mon..6=Sun).
 * This is what gets RENDERED, e.g. `DAY_NAMES_MONDAY_FIRST[fromJsDay(row.day_of_week)]`.
 */
export function fromJsDay(jsDay) {
  return (jsDay + 6) % 7
}
