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
 * IO: pull the next `windowHours` of Glofox events for one location, upsert
 * the active ones into class_occurrences, and reconcile cancellations within
 * the fetched window. Returns stats.
 *
 * Reconciliation (P0-8): after a SUCCESSFUL fetch we know the full set of
 * events Glofox currently reports for [nowMs, nowMs + windowHours]. Any
 * class_occurrences row in that window whose glofox_event_id was NOT among the
 * events we "saw" as active/live has been cancelled (event returned
 * active:false) or deleted (absent entirely) — so we stamp cancelled_at. Rows
 * we DID see get cancelled_at cleared back to null (a cancelled-then-reinstated
 * class un-cancels). Every live/current/booked read filters cancelled_at IS
 * NULL, so a stamped row stops firing the AC / HR-linking.
 *
 * PRIVATE EVENTS: a private event (`private === true`) is a real class that
 * still happens — we just don't break it out into the spine's own columns.
 * We therefore treat private events as SEEN (they count toward "active", so
 * their existing spine row is NOT cancelled) even though we don't upsert them.
 * This keeps the AC running for a private class. Only inactive events
 * (`active === false`) are treated as gone.
 *
 * CRITICAL GUARD: reconciliation only runs when the fetch actually succeeded
 * (`result.ok`) AND returned a usable events array. A failed fetch — or one
 * that returns zero events (a Glofox blip) — cancels NOTHING, so a transient
 * outage can never nuke the whole spine and silently disable AC/HR-linking.
 * The reconcile UPDATE is bounded strictly to this location and the fetched
 * [nowMs, nowMs + windowHours] window.
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

  // Events Glofox currently reports as real (active OR private — private
  // classes still happen). Their spine rows must NOT be cancelled.
  const seenEventIds = new Set()
  const rows = []
  for (const e of result.events || []) {
    if (e?.active === false) continue // inactive → treat as gone (don't mark seen)
    if (e?._id) seenEventIds.add(String(e._id))
    if (e?.private === true) continue // real class, but not upserted into spine columns
    const row = mapEventToOccurrence(e, locationId)
    if (row) rows.push(row)
  }

  // GUARD: only reconcile off a usable payload. Zero events back = likely a
  // Glofox blip; do NOT cancel anything (never nuke the spine on an outage).
  const canReconcile = Array.isArray(result.events) && result.events.length > 0

  let upserted = 0
  if (rows.length > 0) {
    // Un-cancel anything we're re-upserting (reinstated class).
    for (const r of rows) r.cancelled_at = null
    const { error } = await db
      .from('class_occurrences')
      .upsert(rows, { onConflict: 'location_id,glofox_event_id' })
    if (error) {
      logWarn('class-occurrences', 'upsert failed', { locationId, error: error.message })
      return { ok: false, error: error.message, upserted: 0 }
    }
    upserted = rows.length
  }

  let cancelled = 0
  if (canReconcile) {
    // Rows in THIS location within the fetched window that we did NOT see as
    // active/private → cancelled or deleted. Bound strictly to the window.
    const windowStartIso = new Date(nowMs).toISOString()
    const windowEndIso = new Date(nowMs + windowHours * 3600 * 1000).toISOString()
    const { data: existing } = await db
      .from('class_occurrences')
      .select('glofox_event_id')
      .eq('location_id', locationId)
      .gte('starts_at', windowStartIso)
      .lte('starts_at', windowEndIso)
      .is('cancelled_at', null)
    const goneIds = (existing || [])
      .map((r) => r.glofox_event_id)
      .filter((id) => id && !seenEventIds.has(String(id)))
    if (goneIds.length > 0) {
      const { error: cancelErr } = await db
        .from('class_occurrences')
        .update({ cancelled_at: new Date().toISOString() })
        .eq('location_id', locationId)
        .in('glofox_event_id', goneIds)
        .is('cancelled_at', null)
      if (cancelErr) {
        logWarn('class-occurrences', 'cancel reconcile failed', { locationId, error: cancelErr.message })
      } else {
        cancelled = goneIds.length
      }
    }
  }

  return { ok: true, upserted, cancelled, seen: (result.events || []).length }
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
    .is('cancelled_at', null)
    .order('starts_at', { ascending: false })
  for (const occ of data || []) {
    if (occurrenceIsLive(occ, nowMs)) {
      return { glofox_event_id: occ.glofox_event_id, class_name: occ.name || null, ends_at: occ.ends_at ?? null }
    }
  }
  return null
}

/**
 * IO: the class running at a location right now, with the fields the TV
 * class-start intro card needs. Same "most-recently-started live occurrence"
 * resolution as resolveCurrentOccurrence. Returns null when nothing is live.
 * @returns {Promise<null | { glofox_event_id:string, class_name:string|null, program:string|null, starts_at:string }>}
 */
export async function resolveCurrentClassForTv(db, { locationId, nowMs = Date.now() } = {}) {
  if (!db || !locationId) return null
  const sinceIso = new Date(nowMs - 3 * 60 * 60_000).toISOString()
  const untilIso = new Date(nowMs + OCC_PRE_MS).toISOString()
  const { data } = await db
    .from('class_occurrences')
    .select('glofox_event_id, name, program, starts_at, ends_at')
    .eq('location_id', locationId)
    .gte('starts_at', sinceIso)
    .lte('starts_at', untilIso)
    .is('cancelled_at', null)
    .order('starts_at', { ascending: false })
  for (const occ of data || []) {
    if (occurrenceIsLive(occ, nowMs)) {
      return { glofox_event_id: occ.glofox_event_id, class_name: occ.name || null, program: occ.program || null, starts_at: occ.starts_at }
    }
  }
  return null
}
