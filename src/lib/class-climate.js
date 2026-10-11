// CLASS-CLIMATE.1 — pure scheduling logic for the class-climate
// automation. No DB / no vendor calls (safe to import from client
// components). The IO lives in class-climate-runner.js.

// @shared/zoned-time, not @/lib/location-time: the climate cards import this
// file into the browser bundle, and location-time carries the DB side.
import { instantToZonedParts, DEFAULT_TZ } from '@shared/zoned-time'

export const DEFAULT_CONFIG = Object.freeze({
  device_ids: [],
  offset_on_min: 15,   // turn AC on this many minutes before class start
  offset_off_min: 5,   // turn AC off this many minutes after class end
  class_filter: [],    // [] = all classes; else only names containing one of these (case-insensitive)
  excluded_slots: [],  // recurring "<weekday> HH:MM" slots (the location's wall clock) to skip, e.g. "Thu 06:00"
})

const DEFAULT_DURATION_MS = 60 * 60_000

// TZ.10 — the recurring weekly-slot key, in the STUDIO's zone. The key is a
// wall clock ("Thu 06:00"), so it only means anything in the zone of the
// location whose timetable it excludes: the card that writes it and the
// planner that reads it must both pass that location's zone, or a New York
// studio's "Thu 06:00" would be matched against Dublin's 06:00. The SAME key
// is produced on the server (planner) and the browser (card).
// Weekday + 24h time from instantToZonedParts (en-GB, hourCycle h23), so a
// Europe/Dublin key is byte-identical to the old Dublin-pinned formatter's.
const WEEKDAY_ABBR = [null, 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const pad2 = (n) => String(n).padStart(2, '0')

/**
 * Pure: the recurring weekly-slot key for an occurrence's start, in the
 * location's local terms — e.g. "Thu 06:00". Two occurrences a week apart at
 * the same wall-clock time share a key (across a DST change too), which is
 * what makes "exclude this weekly slot" recurring. Returns null on bad input.
 * @param {string|number|Date} startsAt  the occurrence's absolute start
 * @param {string} zone  the location's IANA zone (resolveZone/zoneOfLocation)
 */
export function slotKey(startsAt, zone = DEFAULT_TZ) {
  if (!startsAt) return null
  const d = startsAt instanceof Date ? startsAt : new Date(startsAt)
  if (Number.isNaN(d.getTime())) return null
  const p = instantToZonedParts(d, zone)
  const wd = WEEKDAY_ABBR[p.weekday]
  if (!wd || !Number.isFinite(p.h) || !Number.isFinite(p.mi)) return null
  return `${wd} ${pad2(p.h)}:${pad2(p.mi)}`
}

/**
 * Merge a stored config blob over the defaults, coercing types so a
 * hand-edited JSONB can't crash the runner.
 */
export function resolveConfig(config) {
  const c = config && typeof config === 'object' ? config : {}
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
  return {
    device_ids: Array.isArray(c.device_ids) ? c.device_ids.filter(Boolean) : [],
    offset_on_min: Math.max(0, num(c.offset_on_min, DEFAULT_CONFIG.offset_on_min)),
    offset_off_min: Math.max(0, num(c.offset_off_min, DEFAULT_CONFIG.offset_off_min)),
    class_filter: Array.isArray(c.class_filter)
      ? c.class_filter.filter(Boolean).map((s) => String(s).toLowerCase())
      : [],
    excluded_slots: Array.isArray(c.excluded_slots)
      ? c.excluded_slots.filter(Boolean).map((s) => String(s))
      : [],
  }
}

/**
 * Pure: does this occurrence pass the (optional) class-name filter?
 * Empty filter = all classes match.
 */
export function classMatchesFilter(occurrence, classFilter) {
  if (!Array.isArray(classFilter) || classFilter.length === 0) return true
  const name = String(occurrence?.name || '').toLowerCase()
  return classFilter.some((f) => name.includes(f))
}

/**
 * Pure: which classes should the AC be turned ON for right now?
 *
 * Fire ON when (starts_at - offset_on) <= now <= ends_at AND the class
 * passes the include-filter AND its weekly slot isn't excluded.
 *
 * The OFF is NOT planned here — the runner sets ac_sessions.auto_off_at to
 * (ends_at + offset_off) and the existing ac-auto-off cron performs it.
 *
 * `zone` is the location's IANA zone; only the excluded-slot match reads it.
 * The default is the engine convention (DEFAULT_TZ); every non-test caller
 * passes the location's zone (tests/climate-zone-callers.test.js), and the
 * runner skips a location whose zone it cannot read rather than guess.
 *
 * @param {{ occurrences: Array, config: object, nowMs?: number, zone?: string|null }} args
 * @returns {Array<{ glofox_event_id: string, occurrence: object, endMs: number }>}
 */
export function planClassClimate({ occurrences, config, nowMs = Date.now(), zone = DEFAULT_TZ }) {
  const excluded = new Set(config.excluded_slots || [])
  const out = []
  for (const occ of occurrences || []) {
    if (!occ?.glofox_event_id || !occ.starts_at) continue
    if (!classMatchesFilter(occ, config.class_filter)) continue
    if (excluded.has(slotKey(occ.starts_at, zone))) continue
    const startMs = new Date(occ.starts_at).getTime()
    const endMs = occ.ends_at ? new Date(occ.ends_at).getTime() : startMs + DEFAULT_DURATION_MS
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue
    const windowOpen = startMs - config.offset_on_min * 60_000
    if (nowMs >= windowOpen && nowMs <= endMs) {
      out.push({ glofox_event_id: occ.glofox_event_id, occurrence: occ, endMs })
    }
  }
  return out
}

/**
 * Pure: the auto_off_at for a turned-on class = class end + offset_off.
 * Never returns a past time (clock skew / very short class).
 */
export function autoOffAtFor(occurrence, config, nowMs = Date.now()) {
  const startMs = new Date(occurrence.starts_at).getTime()
  const endMs = occurrence.ends_at ? new Date(occurrence.ends_at).getTime() : startMs + DEFAULT_DURATION_MS
  const off = endMs + config.offset_off_min * 60_000
  return new Date(Math.max(off, nowMs + 60_000)).toISOString()
}
