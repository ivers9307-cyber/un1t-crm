// COMMSFIX.D.3b — <input type="datetime-local"> speaks the BROWSER's local
// wall clock, with no zone attached. Seeding one from
// `new Date(iso).toISOString().slice(0, 16)` therefore writes a UTC wall clock
// into a local-time field — the local/UTC mixing CLAUDE.md bans — and whatever
// reads the field back (`new Date(value)`, which parses as local) lands on a
// different instant. In the campaign editor that shifted a scheduled send an
// hour earlier under IST on every edit round trip.
//
// These two are exact inverses in the browser's zone:
//   isoToLocalDatetime(localDatetimeToIso(v)) === v
//   localDatetimeToIso(isoToLocalDatetime(iso)) === iso
//
// Same shape as the private helpers in SMSBroadcastEditor.jsx, extracted so
// the behaviour is testable under multiple TZs. Nothing here is Dublin-
// specific: the wall clock we want is the operator's own — use
// `@/lib/dublin-time` when the *business* day is what matters.

const pad = (n) => String(n).padStart(2, '0')

/**
 * ISO instant → the `YYYY-MM-DDTHH:mm` string a datetime-local input expects,
 * expressed in the browser's timezone. Returns '' for empty/unparseable input.
 */
export function isoToLocalDatetime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * A datetime-local value → an ISO instant. `new Date()` interprets the
 * local-form string in the browser's timezone, which is what the operator
 * picked. Returns null for an empty picker.
 */
export function localDatetimeToIso(local) {
  if (!local) return null
  const d = new Date(local)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}
