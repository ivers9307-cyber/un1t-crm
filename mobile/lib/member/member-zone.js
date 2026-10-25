// TZ.14 — the member's clock (decision D7 = A): a member's days, weeks and
// months are their HOME studio's (`contacts.location_id` → that studio's
// `locations.timezone`), never the phone's. A member who trains in New York
// keeps a New York streak while travelling; every UN1T member (all six studios
// are Europe/Dublin) sees exactly what they saw before.
//
// The zone arrives with the studio's brand (/api/public/branding?location_id=,
// `timezone`, TZ.14), so it costs the phone no extra read. Until the brand
// lands, or when it cannot be read, the zone is the platform default
// (Europe/Dublin), which is what every screen used before.
//
// Pure: the decisions the member screens take with that zone. The hook is
// mobile/lib/member/use-member-zone.js.

import { DEFAULT_TZ, DAY_MS, resolveZone, dateKeyIn, weekStartMsIn, formatInZone } from 'shared/zoned-time'

/** The brand payload → the member's zone (Dublin floor for absent/invalid). */
export function memberZoneFromBrand(brand) {
  return resolveZone(brand?.timezone)
}

/**
 * The last COMPLETED week in `zone` as a half-open window, for the Home
 * "Your week" digest read. Last week's Monday is re-derived from a point inside
 * last week, so a DST week (23 or 25 hours on one day) stays exact.
 * @returns {{ thisWeekStartMs: number, thisWeekStartIso: string, lastWeekStartIso: string }}
 */
export function lastWeekWindow(nowMs, zone = DEFAULT_TZ) {
  const thisWeekStartMs = weekStartMsIn(nowMs, zone)
  return {
    thisWeekStartMs,
    thisWeekStartIso: new Date(thisWeekStartMs).toISOString(),
    lastWeekStartIso: new Date(weekStartMsIn(thisWeekStartMs - DAY_MS, zone)).toISOString(),
  }
}

/** UTC ms of this week's Monday 00:00 in `zone` (Home's this-week pips). */
export function thisWeekStartMs(nowMs, zone = DEFAULT_TZ) {
  return weekStartMsIn(nowMs, zone)
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * The weekday the member trains on most, by their studio's calendar day, or
 * null without a real pattern (fewer than two sessions on the best day).
 * Home's "You usually train on …" prompt.
 */
export function mostFrequentWeekday(sessions, zone = DEFAULT_TZ) {
  const counts = new Array(7).fill(0)
  let any = false
  for (const s of sessions || []) {
    const iso = s.started_at || s.ended_at
    if (!iso) continue
    const [y, m, d] = dateKeyIn(iso, zone).split('-').map(Number)
    counts[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]++
    any = true
  }
  if (!any) return null
  let bestIdx = 0
  for (let i = 1; i < 7; i++) if (counts[i] > counts[bestIdx]) bestIdx = i
  if (counts[bestIdx] < 2) return null
  return WEEKDAYS[bestIdx]
}

/** A session's start as 'HH:MM' on the member's clock; null without an instant. */
export function memberClockLabel(iso, zone = DEFAULT_TZ) {
  if (!iso) return null
  return formatInZone(new Date(iso), zone, { hour: '2-digit', minute: '2-digit' })
}
