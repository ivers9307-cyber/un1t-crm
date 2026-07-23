// HYROX-TC.1 — pure Dublin-safe mapping from a class occurrence (UTC ISO) to
// (week_no, slot) within a block. No mutation, no IO.
//
// The Dublin-calendar-date read reuses @/lib/dublin-time's dublinDateKey
// (already exported, already the estate's canonical "instant -> Dublin
// YYYY-MM-DD" helper) instead of a private copy of the same Intl formatter.
// dublin-time.js has no ISO-weekday (Mon=1..Sun=7) or day-diff helper, so
// those stay as small self-contained pure functions here.
import { dublinDateKey } from '@/lib/dublin-time'

/** YYYY-MM-DD in Dublin for an ISO instant, or null. */
export function dublinDateStr(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return dublinDateKey(d)
}

/** ISO weekday 1..7 (Mon..Sun) for a YYYY-MM-DD string (pure calendar math). */
export function isoWeekdayOf(ymd) {
  const [y, m, day] = ymd.split('-').map(Number)
  const dow = new Date(Date.UTC(y, m - 1, day, 12)).getUTCDay() // 0..6 Sun..Sat, noon avoids DST edges
  return dow === 0 ? 7 : dow
}

/** Dublin ISO weekday (1..7) for an ISO instant, or null. */
export function dublinWeekday(iso) {
  const ymd = dublinDateStr(iso)
  return ymd ? isoWeekdayOf(ymd) : null
}

/** Whole-day difference b - a between two YYYY-MM-DD strings. */
export function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000)
}

/** 1-based week number for an occurrence; null if before start, past `weeks`, or startsOn is malformed. */
export function weekNoFor(startsOn, occurrenceIso, weeks) {
  const ymd = dublinDateStr(occurrenceIso)
  if (!ymd) return null
  const diff = daysBetween(startsOn, ymd)
  if (!Number.isFinite(diff)) return null
  if (diff < 0) return null
  const wk = Math.floor(diff / 7) + 1
  if (weeks != null && wk > weeks) return null
  return wk
}

/** 1-based slot from session_weekdays (e.g. [3,7]); null if not a session day. */
export function slotFor(sessionWeekdays, occurrenceIso) {
  const wd = dublinWeekday(occurrenceIso)
  if (wd == null) return null
  const idx = sessionWeekdays.indexOf(wd)
  return idx === -1 ? null : idx + 1
}
