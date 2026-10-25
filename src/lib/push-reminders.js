// NOTIF.1 — helpers for the send-push-reminders cron.
//
// Extracted so the timezone math is testable without spinning up
// the full route handler (Supabase + push.js are awkward to mock,
// and the time math is the only bit that's genuinely tricky).

import { zonedWallClockToInstant } from '@/lib/location-time'

/**
 * Treat (dateStr, timeStr) as wall-clock time in `tz`, return the
 * equivalent UTC Date, or null when the inputs or the zone are unusable.
 *
 * dateStr: 'YYYY-MM-DD'
 * timeStr: 'HH:MM' | 'HH:MM:SS'
 * tz:      IANA tz, e.g. 'Europe/Dublin' (the location's own zone)
 *
 * TZ.1b — the private one-pass solver is retired: this delegates to the
 * canonical zonedWallClockToInstant (shared/zoned-time.js). The parse is
 * unchanged, so '24:00' still rolls to the next midnight and an out-of-range
 * day rolls as Date.UTC does. Europe/Dublin answers are identical (every
 * quarter-hour of 2026, src/lib/tz-1b.tz.test.js). Elsewhere it is now right
 * on DST days: the one pass read the offset on the wrong side of the change
 * for a band of hours (New York 03:00-06:59 on spring-forward day was an hour
 * late). A spring-forward gap time resolves EARLIER, the canonical rule.
 * An invalid tz still returns null (Intl throws inside the try). An OMITTED tz
 * now means Europe/Dublin (DEFAULT_TZ); it used to read the host zone. Every
 * caller passes the location's zone.
 */
export function localToUtc(dateStr, timeStr, tz) {
  try {
    const [y, m, d] = dateStr.split('-').map(Number)
    const [hh, mm, ss = '0'] = String(timeStr).split(':')
    const naive = Date.UTC(y, m - 1, d, Number(hh), Number(mm), Number(ss))
    if (Number.isNaN(naive)) return null
    const ms = naiveWallToInstant(naive, tz)
    return ms == null ? null : new Date(ms)
  } catch {
    return null
  }
}

// A wall clock already rolled over by Date.UTC ("naive" ms: the wall clock as
// if it were UTC) → the instant, through the canonical solver. Seconds ride
// along unchanged (the solver works to the minute; offsets do too).
function naiveWallToInstant(naive, tz) {
  const iso = new Date(naive).toISOString()
  const ms = zonedWallClockToInstant(iso.slice(0, 10), iso.slice(11, 16), tz)
  return ms == null ? null : ms + (naive % 60_000)
}

/**
 * Format a 'HH:MM' or 'HH:MM:SS' time string as a friendly 12-hour
 * label for push notification bodies: '14:30:00' → '2:30pm'.
 */
export function formatLocalTime(timeStr) {
  if (!timeStr) return ''
  const [hh, mm] = String(timeStr).split(':')
  const h = Number(hh) % 12 || 12
  const ampm = Number(hh) < 12 ? 'am' : 'pm'
  return `${h}:${mm}${ampm}`
}

/**
 * Returns true if `dueUtcIso` falls inside the fire window around
 * (nowMs + leadMinutes). Pure: makes the cron's window-membership
 * decision testable without faking dates.
 *
 * The window is ASYMMETRIC: up to `windowMin` minutes early, but up to
 * `lateWindowMin` minutes late. A symmetric ±5 window with a 5-minute
 * cron meant two consecutive missed Vercel ticks silently dropped the
 * reminder forever (by the next tick it was outside the window and had
 * never reached the dedup ledger). The wider late side gives missed
 * ticks a catch-up runway; the ledger's UNIQUE constraint still
 * guarantees at-most-once on normal operation. Omitting lateWindowMin
 * keeps the old symmetric behaviour.
 */
export function inLeadWindow(dueUtcIso, nowMs, leadMinutes, windowMin = 5, lateWindowMin = windowMin) {
  const targetMs = nowMs + leadMinutes * 60 * 1000
  const t = new Date(dueUtcIso).getTime()
  const deltaMs = t - targetMs // > 0 = we're early, < 0 = we're late
  return deltaMs <= windowMin * 60 * 1000 && deltaMs >= -lateWindowMin * 60 * 1000
}

/**
 * CRONREADERR.1 — Pure: is this the LAST cron tick that can fire this lead?
 *
 * The push-reminder cron fires an (entity, recipient, lead) while
 * delta = minutesAway - lead is inside [-lateWindowMin, +windowMin]. The next
 * tick comes tickMin later, plus up to jitterMin of Vercel lateness, and sees
 * delta - tickMin - jitterMin. So this tick is the last chance when that falls
 * outside the late edge.
 *
 * Used when the "already sent?" read fails: hold the reminder while a later
 * tick can still send it (no duplicate, no loss), send unchecked only on the
 * last chance (a possible duplicate beats a certain loss). An unreadable input
 * answers true for the same reason.
 *
 * jitterMin defaults to 3.5: Vercel's observed start offsets are 0-95 s with
 * one 196 s outlier, so a later tick can see delta up to tickMin + 3.5 lower.
 * For a due time on the 5-minute grid (delta about -5 then -10 on the ticks
 * after on-time), 3.5 classifies every tick that starts within 90 s of
 * schedule exactly as the old 1-minute allowance did: hold at -5, last at -10.
 *
 * "Last" is not unique for off-grid due times: when delta sits inside the
 * jitter band, two consecutive ticks can both answer true, so a run of failed
 * reads sends at most 2 unchecked (main, which never held, could send 4 across
 * the 20-minute window). The ledger's unique index still records only one.
 *
 * @param {number} minutesAway minutes until the entity is due
 * @param {number} lead        the lead time being fired, in minutes
 * @param {{ lateWindowMin?: number, tickMin?: number, jitterMin?: number }} [opts]
 */
export function isLastFireTick(minutesAway, lead, { lateWindowMin = 15, tickMin = 5, jitterMin = 3.5 } = {}) {
  const delta = Number(minutesAway) - Number(lead)
  if (!Number.isFinite(delta)) return true
  return delta - tickMin - jitterMin < -lateWindowMin
}
