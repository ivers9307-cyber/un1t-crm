// HYROX-TC.1 — pure zone-safe mapping from a class occurrence (UTC ISO) to
// (week_no, slot) within a block. No mutation, no IO.
//
// TZ.9 — the calendar day of an occurrence is the BLOCK's studio day
// (hyrox_blocks.location_id's zone; `starts_on` is a local Monday and
// `session_weekdays` are local weekdays). Callers pass that zone; it defaults
// to DEFAULT_TZ (Europe/Dublin), the old fixed zone, so a Dublin block maps
// exactly as before. The instant -> local day read is shared/zoned-time's
// dateKeyIn (the twin of dublin-time's dublinDateKey); the ISO-weekday and
// day-diff helpers stay small self-contained pure functions here.
import { dateKeyIn, DEFAULT_TZ } from '@shared/zoned-time'

/** YYYY-MM-DD in `zone` for an ISO instant, or null. */
export function zonedDateStr(iso, zone = DEFAULT_TZ) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return dateKeyIn(d, zone)
}

/** ISO weekday 1..7 (Mon..Sun) for a YYYY-MM-DD string (pure calendar math). */
export function isoWeekdayOf(ymd) {
  const [y, m, day] = ymd.split('-').map(Number)
  const dow = new Date(Date.UTC(y, m - 1, day, 12)).getUTCDay() // 0..6 Sun..Sat, noon avoids DST edges
  return dow === 0 ? 7 : dow
}

/** ISO weekday (1..7) in `zone` for an ISO instant, or null. */
export function zonedWeekday(iso, zone = DEFAULT_TZ) {
  const ymd = zonedDateStr(iso, zone)
  return ymd ? isoWeekdayOf(ymd) : null
}

/** Whole-day difference b - a between two YYYY-MM-DD strings. */
export function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000)
}

/** 1-based week number for an occurrence (its day in the block's `zone`); null if before start, past `weeks`, or startsOn is malformed. */
export function weekNoFor(startsOn, occurrenceIso, weeks, zone = DEFAULT_TZ) {
  const ymd = zonedDateStr(occurrenceIso, zone)
  if (!ymd) return null
  const diff = daysBetween(startsOn, ymd)
  if (!Number.isFinite(diff)) return null
  if (diff < 0) return null
  const wk = Math.floor(diff / 7) + 1
  if (weeks != null && wk > weeks) return null
  return wk
}

/** 1-based slot from session_weekdays (e.g. [3,7], local weekdays in the block's `zone`); null if not a session day. */
export function slotFor(sessionWeekdays, occurrenceIso, zone = DEFAULT_TZ) {
  const wd = zonedWeekday(occurrenceIso, zone)
  if (wd == null) return null
  const idx = sessionWeekdays.indexOf(wd)
  return idx === -1 ? null : idx + 1
}
