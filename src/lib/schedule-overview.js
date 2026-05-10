// schedule-overview — pure helpers for the studio overview strip
// (mig 125). Computes per-day demand vs supply and classifies a day
// as red (uncovered) / amber (undermanned) / green (sufficient).
//
// Demand is COMMITMENT-based:
//   - Every event scheduled that day adds events.staff_required
//   - Every Calendly event_type with availability for that day adds
//     event_types.staff_required (regardless of actual booking
//     count — the bookable surface needs coverage)
//
// Supply is the count of staff scheduled to work, minus those on
// leave that overlaps the day. The receiver passes pre-computed
// numbers; this module is pure and doesn't touch the DB.
//
// Why these helpers exist as a pure module: classification rules
// will get tweaked over time (operator feedback after first month
// of use will probably move the amber threshold or change how
// staff_required=0 is treated). Keeping them out of the API route
// means tests cover every branch and the API stays focused on
// data assembly.

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/**
 * Does this Calendly event_type's availability JSON have a window
 * for the given day-of-week? availability is the same shape used
 * by /api/public/bookings/[slug]/slots:
 *   { mon: { start: 'HH:MM', end: 'HH:MM' }, tue: ..., ... }
 *
 * A null/undefined availability or a missing day key = no window.
 *
 * @param {object|null|undefined} availability
 * @param {string} dateIso  YYYY-MM-DD (the date being evaluated)
 * @returns {boolean}
 */
export function eventTypeHasWindowForDate(availability, dateIso) {
  if (!availability || typeof availability !== 'object') return false
  if (!dateIso) return false
  // Construct date in UTC (avoids tz-shift bugs around midnight)
  const [y, m, d] = String(dateIso).split('-').map(Number)
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return false
  const dayName = DAY_NAMES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
  const window = availability[dayName]
  // Treat any non-null window object with start+end as bookable.
  // Some operators use null to disable a day; some use { start: null }.
  if (!window || typeof window !== 'object') return false
  return !!(window.start && window.end)
}

/**
 * Sum staff_required across an array of items where each has a
 * `staff_required` numeric field. Defensive against null entries
 * (treated as 0) and missing fields (treated as 1 — matches the
 * column DEFAULT so an item without an explicit value still
 * contributes baseline demand).
 *
 *   sumStaffRequired([])                          → 0
 *   sumStaffRequired([{staff_required: 4}])       → 4
 *   sumStaffRequired([{staff_required: 0}])       → 0
 *   sumStaffRequired([{staff_required: null}])    → 1 (column default)
 *   sumStaffRequired([{}])                        → 1 (missing = default)
 *
 * @param {Array<{staff_required:number|null}>|null|undefined} items
 * @returns {number}
 */
export function sumStaffRequired(items) {
  if (!Array.isArray(items)) return 0
  let total = 0
  for (const item of items) {
    if (!item) continue
    const v = item.staff_required
    if (v === 0) continue                    // explicit 0 — covered by another role
    if (v == null) { total += 1; continue }  // missing → DB default
    const n = Number(v)
    if (Number.isFinite(n)) total += n
  }
  return total
}

/**
 * Compute total demand for a day from both sources:
 *   - events scheduled that day (events.staff_required)
 *   - Calendly event_types with a window for that day
 *     (event_types.staff_required)
 *
 * @param {object} input
 * @param {Array<{staff_required:number|null}>} input.events
 *        Multi-kind events on this date.
 * @param {Array<{staff_required:number|null, availability:object}>} input.event_types
 *        ALL active Calendly templates at the location — filtering
 *        to "has a window today" happens here so callers don't have
 *        to pre-filter.
 * @param {string} input.date  YYYY-MM-DD
 * @returns {number}
 */
export function aggregateDayDemand({ events, event_types, date }) {
  const eventDemand = sumStaffRequired(events)
  const bookingDemand = sumStaffRequired(
    (event_types || []).filter((et) => eventTypeHasWindowForDate(et?.availability, date)),
  )
  return eventDemand + bookingDemand
}

/**
 * Classify a single day as red / amber / green based on demand vs
 * supply. The rules are deliberately simple — operator feedback
 * after first-month use will probably tune them.
 *
 *   red    — demand > 0 AND effective supply == 0
 *            (committed coverage with literally nobody rostered)
 *   amber  — supply < demand (rostered but undermanned)
 *   green  — supply >= demand OR demand == 0
 *
 * Effective supply = staff_scheduled - staff_on_leave.
 *
 * @param {object} input
 * @param {number} input.demand
 * @param {number} input.staff_scheduled
 * @param {number} input.staff_on_leave
 * @returns {'red' | 'amber' | 'green'}
 */
export function classifyDayLoad({ demand, staff_scheduled, staff_on_leave }) {
  const supply = Math.max(0, (staff_scheduled || 0) - (staff_on_leave || 0))
  if (demand > 0 && supply === 0) return 'red'
  if (demand > 0 && supply < demand) return 'amber'
  return 'green'
}
