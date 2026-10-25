// Date helpers for the customer agent's event tools (event-tools.js,
// event-move-tools.js). Pure; its own module so the two tool files share it
// without importing each other.
import { todayStrIn, DEFAULT_TZ } from '@/lib/location-time'

// race_date is a DATE: a calendar day, with no instant in it. TZ.5 — it is
// labelled in UTC from a noon-UTC anchor, so the label is the date itself in
// any zone (it used to be read in Dublin, which is the same day for a noon-UTC
// anchor; a zone east of UTC+12 would have shifted it).
const DATE_FMT = new Intl.DateTimeFormat('en-IE', {
  timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short',
})

export function dateLabel(dateStr) {
  const parts = {}
  for (const p of DATE_FMT.formatToParts(new Date(`${dateStr}T12:00:00Z`))) {
    parts[p.type] = p.value
  }
  return `${parts.weekday} ${parts.day} ${parts.month}`
}

/**
 * Today 'YYYY-MM-DD' on the studio's clock, comparable to the DATE column as
 * a string. TZ.5 — `zone` is the event's location zone (the tools only ever
 * read the conversation location's events, so ctx.zone). Pure.
 */
export function todayIn(nowMs, zone = DEFAULT_TZ) {
  return todayStrIn(zone, nowMs)
}
