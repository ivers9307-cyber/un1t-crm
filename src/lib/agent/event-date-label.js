// Date helpers for the customer agent's event tools (event-tools.js,
// event-move-tools.js). Pure; its own module so the two tool files share it
// without importing each other.

const DUBLIN_DATE_FMT = new Intl.DateTimeFormat('en-IE', {
  timeZone: 'Europe/Dublin', weekday: 'short', day: 'numeric', month: 'short',
})

// race_date is a DATE (Dublin wall-clock by convention) — anchor on
// noon UTC so the label never shifts a day in any timezone (the
// booking-confirmations lesson).
export function dateLabel(dateStr) {
  const parts = {}
  for (const p of DUBLIN_DATE_FMT.formatToParts(new Date(`${dateStr}T12:00:00Z`))) {
    parts[p.type] = p.value
  }
  return `${parts.weekday} ${parts.day} ${parts.month}`
}

export function dublinToday(nowMs) {
  // en-CA gives YYYY-MM-DD, comparable to the DATE column as a string.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).format(new Date(nowMs))
}
