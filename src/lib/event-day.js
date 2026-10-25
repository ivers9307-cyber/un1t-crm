// event-day — TZ.9. The one place an event's DAY is decided.
//
// An event's clock is its studio's: race_events.location_id's
// `locations.timezone` (a host event's location IS the host's anchor
// location, so a host event follows its anchor). race_date, start_time and
// race_waves.start_time are wall clock in that zone. Every UN1T studio is
// Europe/Dublin, so for UN1T each answer here is exactly the old
// dublinTodayStr() one (events-races.tz.test.js pins it).
//
// The zone rides the event row: select the location embed WITH its timezone
// (`locations:location_id ( …, timezone )`) and hand the row in. A row with
// no embed, or no location, is DEFAULT_TZ (as zoneOfLocation answers for a
// missing row), so a read that loses the embed degrades to the old Dublin
// behaviour rather than to a guess.
import { zoneOfLocation, todayStrIn, dayStrIn, addDaysISO } from '@/lib/location-time'
import { formatWeekdayLongDateInTZ } from '@/lib/dates'

/** The event row's studio zone (needs the `locations` embed with `timezone`). */
export function eventZone(event) {
  return zoneOfLocation(event?.locations)
}

/** Today 'YYYY-MM-DD' at the event's studio. */
export function eventToday(event, nowMs = Date.now()) {
  return todayStrIn(eventZone(event), nowMs)
}

/**
 * The earliest "today" any studio can have at `nowMs`: the UTC day before
 * (no IANA zone runs more than a day behind UTC). A query that spans studios
 * filters `race_date >= earliestLocalToday()` and then narrows each row by its
 * own eventToday(); for a Dublin row the result is exactly the old
 * `race_date >= dublinToday` set.
 */
export function earliestLocalToday(nowMs = Date.now()) {
  return addDaysISO(dayStrIn(nowMs, 'UTC'), -1)
}

/**
 * "Sunday 1 November 2026" for a race_date. A calendar DATE has no zone: read
 * at UTC midnight in UTC it is the stored day in every studio's zone (reading
 * it in the studio's zone would print the day BEFORE for any studio west of
 * UTC). Byte-identical to the Europe/Dublin rendering it replaces, which never
 * moved a UTC midnight off its day. '' for no date; an unparseable value is
 * echoed back, as before.
 */
export function eventDateLong(dateStr) {
  if (!dateStr) return ''
  return formatWeekdayLongDateInTZ(dateStr, 'UTC') || dateStr
}
