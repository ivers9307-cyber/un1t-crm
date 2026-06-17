// CLASS-CLIMATE.1 — the schedule "spine": mirror the Glofox timetable
// into class_occurrences so schedule-driven automations (and, later, HR
// allocation) can read "what class runs when, where" without a live
// Glofox call on every tick.
//
// Pure mappers are exported + unit-tested; syncOccurrencesForLocation
// does the IO (fetch + upsert).

import { fetchUpcomingEvents } from '@/lib/glofox'
import { logWarn } from '@/lib/log'

export const DEFAULT_CLASS_MINUTES = 60

/**
 * Glofox `time_start` has arrived as either unix seconds or unix millis
 * across endpoints (the /2.0/events probe sample was truncated). Same
 * defensive heuristic the inbox classes route uses.
 * @returns {number|null} epoch millis
 */
export function toMillis(timeStart) {
  if (typeof timeStart === 'number' && Number.isFinite(timeStart)) {
    return timeStart < 1e12 ? timeStart * 1000 : timeStart
  }
  if (typeof timeStart === 'string') {
    const t = new Date(timeStart).getTime()
    return Number.isFinite(t) ? t : null
  }
  return null
}

/**
 * Glofox `duration` unit is unconfirmed from the truncated probe, so
 * normalise defensively to MINUTES:
 *   < 600        → already minutes (≤ 10h)
 *   < 86400      → seconds → minutes
 *   otherwise    → millis → minutes
 * Returns null when unparseable; the caller falls back to
 * DEFAULT_CLASS_MINUTES.
 */
export function durationToMinutes(duration) {
  const n = Number(duration)
  if (!Number.isFinite(n) || n <= 0) return null
  if (n < 600) return Math.round(n)
  if (n < 86400) return Math.round(n / 60)
  return Math.round(n / 60000)
}

/**
 * Pure: shape one Glofox event into a class_occurrences upsert row.
 * Returns null when the event lacks the bits we need (id or start).
 *
 * @param {object} event       a /2.0/events item
 * @param {string} locationId
 */
export function mapEventToOccurrence(event, locationId) {
  if (!event || !event._id || !locationId) return null
  const startMs = toMillis(event.time_start)
  if (startMs == null) return null

  const durMin = durationToMinutes(event.duration) ?? DEFAULT_CLASS_MINUTES
  const endMs = startMs + durMin * 60_000

  const instructor = Array.isArray(event.trainers)
    ? (event.trainers
        .map((t) => (typeof t === 'string' ? t : t?.name || t?.first_name || null))
        .filter((t) => t && !/^[0-9a-f]{24}$/i.test(t))
        .join(', ') || null)
    : null

  const capRaw = event.size
  const capacity = (capRaw && typeof capRaw === 'object' && !Array.isArray(capRaw))
    ? (Number(capRaw.limit ?? capRaw.max ?? capRaw.total ?? capRaw.size) || null)
    : (Number(capRaw) || null)

  return {
    location_id: locationId,
    glofox_event_id: String(event._id),
    name: event.name ? String(event.name).slice(0, 200) : null,
    program: event.program_obj?.name ? String(event.program_obj.name).slice(0, 200) : null,
    starts_at: new Date(startMs).toISOString(),
    ends_at: new Date(endMs).toISOString(),
    capacity,
    instructor: instructor ? instructor.slice(0, 200) : null,
    raw: event,
    synced_at: new Date().toISOString(),
  }
}

/**
 * IO: pull the next `windowHours` of Glofox events for one location and
 * upsert them into class_occurrences. Inactive + private events are
 * skipped. Returns stats.
 *
 * @param {object} db  service-role client
 * @param {{ locationId: string, creds: object, windowHours?: number, nowMs?: number }} opts
 */
export async function syncOccurrencesForLocation(db, { locationId, creds, windowHours = 48, nowMs = Date.now() }) {
  const startSec = Math.floor(nowMs / 1000)
  const endSec = startSec + windowHours * 3600
  const result = await fetchUpcomingEvents(creds, { start: startSec, end: endSec, limit: 200 })
  if (!result.ok) {
    return { ok: false, error: result.body?.message || `HTTP ${result.status}`, upserted: 0 }
  }

  const rows = []
  for (const e of result.events) {
    if (e?.active === false || e?.private === true) continue
    const row = mapEventToOccurrence(e, locationId)
    if (row) rows.push(row)
  }
  if (rows.length === 0) return { ok: true, upserted: 0, seen: result.events.length }

  const { error } = await db
    .from('class_occurrences')
    .upsert(rows, { onConflict: 'location_id,glofox_event_id' })
  if (error) {
    logWarn('class-occurrences', 'upsert failed', { locationId, error: error.message })
    return { ok: false, error: error.message, upserted: 0 }
  }
  return { ok: true, upserted: rows.length, seen: result.events.length }
}

// ── "which class is on right now?" (HR-CLASS-ALLOC.1) ────────────
//
// Grace windows: a member is plausibly "in the class" from a bit before
// start (arriving / warming up) to a bit after end (cooling down).
const OCC_PRE_MS = 20 * 60_000
const OCC_POST_MS = 10 * 60_000

/**
 * Pure: is this occurrence "live" at nowMs (inside the pre/post grace
 * window around start..end)?
 */
export function occurrenceIsLive(occ, nowMs, { preMs = OCC_PRE_MS, postMs = OCC_POST_MS } = {}) {
  if (!occ?.starts_at) return false
  const start = new Date(occ.starts_at).getTime()
  const end = occ.ends_at ? new Date(occ.ends_at).getTime() : start + 60 * 60_000
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false
  return nowMs >= start - preMs && nowMs <= end + postMs
}

/**
 * IO: the class occurrence running at a location right now (the most
 * recently-started live one), or null. Reads the spine — no live Glofox
 * call. Used to stamp a HR session with the class it happened in.
 *
 * @param {object} db  service-role client
 * @param {{ locationId: string, nowMs?: number }} opts
 * @returns {Promise<null | { glofox_event_id: string, class_name: string|null }>}
 */
export async function resolveCurrentOccurrence(db, { locationId, nowMs = Date.now() } = {}) {
  if (!db || !locationId) return null
  const sinceIso = new Date(nowMs - 3 * 60 * 60_000).toISOString()
  const untilIso = new Date(nowMs + OCC_PRE_MS).toISOString()
  const { data } = await db
    .from('class_occurrences')
    .select('glofox_event_id, name, starts_at, ends_at')
    .eq('location_id', locationId)
    .gte('starts_at', sinceIso)
    .lte('starts_at', untilIso)
    .order('starts_at', { ascending: false })
  for (const occ of data || []) {
    if (occurrenceIsLive(occ, nowMs)) {
      return { glofox_event_id: occ.glofox_event_id, class_name: occ.name || null }
    }
  }
  return null
}
