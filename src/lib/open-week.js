// OPENWEEK.1 — the open week rules, one judge for the page, the classes list
// and the claim route. An open week is a corp_promos row of kind 'open_week'
// (mig 847): a window of studio-local dates and two limits (max_classes in all,
// max_per_day on one day). A visitor picks classes inside the window; the claim
// grants exactly that many and books each one.
//
// Pure: no I/O. Every date is judged on the studio's clock (`zone`, from
// zoneOfLocation), never the server's.
import { dayStrIn, addDaysISO, zonedWallClockToInstant, DAY_MS } from '@/lib/location-time'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const isDate = (v) => typeof v === 'string' && DATE_RE.test(v)

/** Is `promo` (a promoView row) an open week with a readable window? */
export function isOpenWeek(promo) {
  return !!promo && promo.kind === 'open_week' && isDate(promo.windowStartsOn) && isDate(promo.windowEndsOn)
}

/** 'over' once today, on the studio clock, is after the window's last day; else 'open' (signup opens before the week). */
export function openWeekState(promo, zone, now = new Date()) {
  return dayStrIn(now, zone) > promo.windowEndsOn ? 'over' : 'open'
}

/** Days to read from today so the read reaches the end of the window's last day (at least 1). */
export function openWeekReadDays(promo, zone, now = new Date()) {
  const today = dayStrIn(now, zone)
  const days = Math.round((Date.parse(`${promo.windowEndsOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS) + 1
  return Math.max(1, days)
}

/** The instant the window opens: 00:00 on its first day in the studio zone. */
export function openWeekStartMs(promo, zone) {
  return zonedWallClockToInstant(promo.windowStartsOn, '00:00', zone)
}

/** Is this public class (its studio-local `day`) inside the window, both ends included? */
export function inOpenWeek(cls, promo) {
  return !!cls && isDate(cls.day) && cls.day >= promo.windowStartsOn && cls.day <= promo.windowEndsOn
}

/**
 * Judge the visitor's picks against the server's own read (`classes`, already
 * limited to the window). Ids are deduped first; picks come back in start order.
 * @returns {{ ok: true, picks: { event_id: string, name: string, starts_at: string, day: string }[] }
 *   | { ok: false, code: 'none_picked'|'too_many'|'two_on_one_day'|'class_unavailable', eventId?: string }}
 */
export function judgeOpenWeekPicks(eventIds, classes, promo) {
  const ids = [...new Set((Array.isArray(eventIds) ? eventIds : []).filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()))]
  if (ids.length === 0) return { ok: false, code: 'none_picked' }
  if (ids.length > promo.maxClasses) return { ok: false, code: 'too_many' }
  const byId = new Map((Array.isArray(classes) ? classes : []).filter((c) => c && c.event_id).map((c) => [String(c.event_id), c]))
  const picks = []
  for (const id of ids) {
    const c = byId.get(id)
    if (!c) return { ok: false, code: 'class_unavailable', eventId: id }
    picks.push({ event_id: String(c.event_id), name: c.name, starts_at: c.starts_at, day: c.day })
  }
  const perDay = new Map()
  for (const p of picks) perDay.set(p.day, (perDay.get(p.day) || 0) + 1)
  if ([...perDay.values()].some((n) => n > promo.maxPerDay)) return { ok: false, code: 'two_on_one_day' }
  picks.sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)))
  return { ok: true, picks }
}

/**
 * Whole days of credit validity (un1t.online's /credits/grant takes only
 * expiresInDays): the fewest n >= 1 with now + n days at or past 00:00 on the
 * day after the window's last day, in the studio zone. May run up to a day
 * past the window; never ends before its last class.
 */
export function openWeekExpiresInDays(promo, zone, now = new Date()) {
  const endMs = zonedWallClockToInstant(addDaysISO(promo.windowEndsOn, 1), '00:00', zone)
  return Math.max(1, Math.ceil((endMs - now.getTime()) / DAY_MS))
}
