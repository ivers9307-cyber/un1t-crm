// mobile/lib/month-calendar.js
//
// The tap rule of components/MonthCalendar.jsx (a controlled range picker),
// pure so the forms that use it can be tested against the real rule.
// ISO 'YYYY-MM-DD' strings compare in date order; no Date, so no timezone.

/**
 * A tap on `iso` → the new { start, end } to hand onChange, or null to ignore.
 *   no start, or both ends held → start afresh on the tapped day (end null)
 *   a start and no end          → extend to a later (or the same) day,
 *                                 restart on an earlier one
 */
export function calendarTap({ startDate = null, endDate = null, minDate = null } = {}, iso) {
  if (minDate && iso < minDate) return null
  if (!startDate || endDate) return { start: iso, end: null }
  return iso >= startDate ? { start: startDate, end: iso } : { start: iso, end: null }
}
