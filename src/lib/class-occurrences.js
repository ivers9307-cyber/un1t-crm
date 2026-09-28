// CLASS-CLIMATE.1 — the schedule "spine": mirror the Glofox timetable
// into class_occurrences so schedule-driven automations (and, later, HR
// allocation) can read "what class runs when, where" without a live
// Glofox call on every tick.
//
// Pure mappers are exported + unit-tested; syncOccurrencesForLocation
// does the IO (fetch + upsert).

import { fetchUpcomingEvents, fetchGlofoxTrainers, fetchMemberResult, glofoxDisplayName } from '@/lib/glofox'
import { dublinTimeLabel } from '@/lib/dublin-time'
import { logWarn, logError } from '@/lib/log'

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

const TRAINER_ID_RE = /^[0-9a-f]{24}$/i

/**
 * STUDIO-KPI.4 — pure: distinct trainer ids (24-hex, lowercased) across
 * a batch of Glofox events. Entries arrive as bare id strings or as
 * objects carrying _id; anything name-like is not an id.
 */
export function extractTrainerIds(events) {
  const ids = new Set()
  for (const e of Array.isArray(events) ? events : []) {
    if (!Array.isArray(e?.trainers)) continue
    for (const t of e.trainers) {
      const id = typeof t === 'string' ? t : (t?._id != null ? String(t._id) : null)
      if (id && TRAINER_ID_RE.test(id)) ids.add(id.toLowerCase())
    }
  }
  return [...ids]
}

/**
 * Pure: one event's trainers[] → the instructor label. Ids resolve
 * through nameMap (keys lowercase); inline name strings/objects pass
 * through as before; unresolved ids drop so the label never shows a
 * raw ObjectId.
 */
function resolveInstructor(trainers, nameMap) {
  if (!Array.isArray(trainers)) return null
  return (
    trainers
      .map((t) => {
        const id = typeof t === 'string' ? t : (t?._id != null ? String(t._id) : null)
        const mapped = id && nameMap ? nameMap[id.toLowerCase()] : null
        if (typeof mapped === 'string' && mapped.trim()) return mapped.trim()
        return typeof t === 'string' ? t : t?.name || t?.first_name || null
      })
      .filter((t) => t && !TRAINER_ID_RE.test(t))
      .join(', ') || null
  )
}

/**
 * Pure: shape one Glofox event into a class_occurrences upsert row.
 * Returns null when the event lacks the bits we need (id or start).
 *
 * @param {object} event       a /2.0/events item
 * @param {string} locationId
 * @param {object} [trainerNames]  trainer id (lowercase) → display name
 */
export function mapEventToOccurrence(event, locationId, trainerNames = null) {
  if (!event || !event._id || !locationId) return null
  const startMs = toMillis(event.time_start)
  if (startMs == null) return null

  const durMin = durationToMinutes(event.duration) ?? DEFAULT_CLASS_MINUTES
  const endMs = startMs + durMin * 60_000

  const instructor = resolveInstructor(event.trainers, trainerNames)

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

// STUDIO-KPI.4 — cap on per-id /2.0/members fallback lookups per sync
// run. Stillorgan has ~3 distinct trainers; the cap only guards against
// a pathological payload fanning out into dozens of API calls.
const TRAINER_MEMBER_LOOKUP_CAP = 10

// How far back the instructor backfill patches historical rows. The
// scorecard's floor table reads 28 days (shared/studio-kpis.js
// fetchFloor) — 35 gives it margin without touching deep history.
const BACKFILL_DAYS = 35

// TRAINERCALLS.1 — the sync asks the Glofox API for trainer names on ONE
// tick a day: the */15 tick that lands in [04:00, 04:15) Dublin wall clock
// (04:00 exists on both DST days; the 04:15 tick is outside, so exactly one).
// Live on 27 Sep 2026 every tick spent 1 /2.0/trainers call + one
// /2.0/members call per trainer id in the window (each answered "200
// success:false, Resource not available"), ~480 futile calls a day, and
// instructor was NULL on 647/647 rows. Overrides still apply on every tick
// (they cost no call), and every other tick reuses the names the spine
// already holds (readSpineTrainerNames) for ids that LEAD A SINGLE-TRAINER
// class, so those names do not flap to NULL between lookups. An id seen only
// in multi-trainer classes has no such memory: on a non-lookup tick its name
// drops out of the joined label ("A, B" becomes "A"), and past multi-trainer
// rows keep whatever label they had (CLASSLINK.1 inherits this; pinned by a
// test). Stateless on purpose: a Vercel function instance is not a cache
// (consecutive ticks ran on different deployments).
// vercel.json's */15 schedule is asserted by the route's test.
export const TRAINER_LOOKUP_DUBLIN_HOUR = 4
const TRAINER_LOOKUP_WINDOW_MIN = 15

/**
 * Pure: is `nowMs` the day's trainer-lookup tick (Dublin 04:00–04:14)?
 * @param {number} nowMs epoch millis
 */
export function isTrainerLookupTick(nowMs) {
  if (!Number.isFinite(nowMs)) return false
  const label = dublinTimeLabel(new Date(nowMs).toISOString()) // 'HH:MM', Dublin
  if (!label) return false
  const [h, m] = label.split(':').map(Number)
  return h === TRAINER_LOOKUP_DUBLIN_HOUR && m < TRAINER_LOOKUP_WINDOW_MIN
}

/**
 * IO: the names the spine already holds for these trainer ids: on this
 * location's single-trainer rows of the last BACKFILL_DAYS whose
 * instructor is set, raw.trainers[0] → that label, the newest row winning.
 * (Multi-trainer rows carry a joined "A, B" label, not one person's name.)
 * So only an id that LEADS A SINGLE-TRAINER class in the window can be
 * remembered; an id that only ever co-teaches gets no name here.
 *
 * A failed read is an ERROR, never "no names": the caller asks Glofox this
 * tick instead (the behaviour before TRAINERCALLS.1).
 *
 * Bounded: one studio, 35 days, named single-trainer rows for the window's
 * ids, ≤ ~230 rows today; newest first, so the 500 cap only ever drops the
 * oldest.
 *
 * @returns {Promise<{ names: Record<string,string>, error: (object|null) }>}
 */
export async function readSpineTrainerNames(db, { locationId, trainerIds, nowMs = Date.now() } = {}) {
  const ids = [...new Set((trainerIds || []).filter(Boolean).map((id) => String(id).toLowerCase()))]
  if (!db || !locationId || ids.length === 0) return { names: {}, error: null }
  const sinceIso = new Date(nowMs - BACKFILL_DAYS * 86_400_000).toISOString()
  const { data, error } = await db
    .from('class_occurrences')
    .select('instructor, starts_at, trainer_id:raw->trainers->>0')
    .eq('location_id', locationId)
    .gte('starts_at', sinceIso)
    .in('raw->trainers->>0', ids)
    .is('raw->trainers->>1', null)
    .not('instructor', 'is', null)
    .order('starts_at', { ascending: false })
    .limit(500)
  if (error) return { names: {}, error }
  const names = {}
  const seenAt = {}
  for (const r of data || []) {
    const id = typeof r?.trainer_id === 'string' ? r.trainer_id.toLowerCase() : null
    const label = typeof r?.instructor === 'string' ? r.instructor.trim() : ''
    if (!id || !label || TRAINER_ID_RE.test(label)) continue
    if (!(id in seenAt) || String(r.starts_at) > seenAt[id]) {
      seenAt[id] = String(r.starts_at)
      names[id] = label
    }
  }
  return { names, error: null }
}

/**
 * STUDIO-KPI.4 / TRAINERCALLS.1 — IO: trainer id → display name for a
 * batch of ids, plus how many Glofox requests it attempted. Resolution
 * order, all best-effort (an unresolved id just stays out of the map and
 * the occurrence's instructor stays null):
 *   1. operator overrides — settings.glofox.trainer_names, carried on
 *      creds.trainerNames by glofoxCredentialsForLocation (no API call);
 *   2. only when `lookup`: GET /2.0/trainers (may not exist on this tier —
 *      returns []), then GET /2.0/members/{id} per remaining id (trainers are
 *      users in Glofox's model), capped at TRAINER_MEMBER_LOOKUP_CAP;
 *   3. `known` — names the caller already holds (the sync passes the
 *      spine's, readSpineTrainerNames: ids that lead a single-trainer
 *      class only), for ids steps 1-2 left unnamed.
 *
 * @param {object} creds  per-location credentials (+ trainerNames)
 * @param {string[]} trainerIds
 * @param {{ lookup?: boolean, known?: (Record<string,string>|null) }} [opts]
 *   lookup defaults to true (a live lookup, as before); known to none.
 * @returns {Promise<{ names: Record<string,string>, apiCalls: number }>}
 *   names keyed lowercase; apiCalls = Glofox requests attempted.
 */
export async function resolveTrainerNamesWithStats(creds, trainerIds, { lookup = true, known = null } = {}) {
  const ids = [...new Set((trainerIds || []).filter(Boolean).map((id) => String(id).toLowerCase()))]
  const map = {}
  let apiCalls = 0
  if (ids.length === 0) return { names: map, apiCalls }

  const overrides = {}
  if (creds?.trainerNames && typeof creds.trainerNames === 'object') {
    for (const [id, name] of Object.entries(creds.trainerNames)) {
      if (typeof name === 'string' && name.trim()) overrides[id.toLowerCase()] = name.trim()
    }
  }
  for (const id of ids) {
    if (overrides[id]) map[id] = overrides[id]
  }

  let unknown = ids.filter((id) => !map[id])

  if (lookup && unknown.length > 0) {
    apiCalls++
    const trainers = await fetchGlofoxTrainers(creds)
    if (trainers.length > 0) {
      const byId = new Map()
      for (const t of trainers) {
        const id = t?._id != null ? String(t._id).toLowerCase() : null
        const name = glofoxDisplayName(t)
        if (id && name) byId.set(id, name)
      }
      for (const id of unknown) {
        const name = byId.get(id)
        if (name) map[id] = name
      }
      unknown = unknown.filter((id) => !map[id])
    }

    for (const id of unknown.slice(0, TRAINER_MEMBER_LOOKUP_CAP)) {
      apiCalls++
      const { ok, member } = await fetchMemberResult(creds, id)
      if (ok) {
        const name = glofoxDisplayName(member)
        if (name) map[id] = name
      }
    }
    unknown = unknown.filter((id) => !map[id])
  }

  if (known && typeof known === 'object') {
    for (const id of unknown) {
      const name = known[id]
      if (typeof name === 'string' && name.trim()) map[id] = name.trim()
    }
  }
  return { names: map, apiCalls }
}

/**
 * STUDIO-KPI.4 — trainer id → display name (keys lowercase). A live lookup
 * unless opts say otherwise; the Glofox settings tab's "Seen in the
 * timetable" list (GET /api/locations/[id]/glofox-trainers) relies on that.
 * @returns {Promise<Record<string, string>>}
 */
export async function resolveTrainerNames(creds, trainerIds, opts) {
  return (await resolveTrainerNamesWithStats(creds, trainerIds, opts)).names
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

  // STUDIO-KPI.4 — resolve trainer ids to names so class_occurrences.instructor
  // populates and the scorecard's floor table can group per coach.
  // TRAINERCALLS.1 — the Glofox API is asked on the day's lookup tick only;
  // every tick applies overrides and the names the spine already holds for
  // ids that lead a single-trainer class (a multi-trainer-only id goes
  // unnamed until the next lookup tick). A failed spine read asks Glofox
  // this tick (the old behaviour), logged.
  const trainerIds = extractTrainerIds(result.events)
  let trainerNames = {}
  let trainerLookup = 'none'
  let trainerApiCalls = 0
  if (trainerIds.length > 0) {
    const spine = await readSpineTrainerNames(db, { locationId, trainerIds, nowMs })
    if (spine.error) {
      logError('class-occurrences', 'spine trainer-name read failed; asking Glofox this tick', {
        locationId, error: spine.error.message,
      })
    }
    trainerLookup = isTrainerLookupTick(nowMs) ? 'daily' : (spine.error ? 'fallback' : 'skipped')
    const resolved = await resolveTrainerNamesWithStats(creds, trainerIds, {
      lookup: trainerLookup !== 'skipped',
      known: spine.names,
    })
    trainerNames = resolved.names
    trainerApiCalls = resolved.apiCalls
  }

  // Events Glofox currently reports as real (active OR private — private
  // classes still happen). Their spine rows must NOT be cancelled.
  const seenEventIds = new Set()
  const rows = []
  for (const e of result.events || []) {
    if (e?.active === false) continue // inactive → treat as gone (don't mark seen)
    if (e?._id) seenEventIds.add(String(e._id))
    if (e?.private === true) continue // real class, but not upserted into spine columns
    const row = mapEventToOccurrence(e, locationId, trainerNames)
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
      return { ok: false, error: error.message, upserted: 0, trainerLookup, trainerApiCalls }
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

  // STUDIO-KPI.4 — instructor backfill. The sync window is [now, +48h],
  // so PAST rows are never re-upserted — but the scorecard's floor table
  // reads 28 days of history. For every trainer we can name, patch the
  // last BACKFILL_DAYS of this location's rows:
  //   1. fill: instructor IS NULL + raw.trainers[0] = id → name. Covers
  //      the whole pre-mapping backlog in the first tick after deploy.
  //   2. correct: single-trainer rows (raw->trainers->>1 is null) whose
  //      stored instructor differs → name. Makes an operator override
  //      retroactive. Multi-trainer rows are owned by the upsert path
  //      (joined "A, B" labels) — correcting them down to trainers[0]
  //      would churn against the next upsert, so they're excluded.
  // Both UPDATEs are bounded (location + window + trainer id) and
  // idempotent — steady-state they match zero rows.
  for (const [trainerId, name] of Object.entries(trainerNames)) {
    const label = name.slice(0, 200)
    const backfillSinceIso = new Date(nowMs - BACKFILL_DAYS * 86_400_000).toISOString()
    const { error: fillErr } = await db
      .from('class_occurrences')
      .update({ instructor: label })
      .eq('location_id', locationId)
      .is('instructor', null)
      .gte('starts_at', backfillSinceIso)
      .eq('raw->trainers->>0', trainerId)
    if (fillErr) {
      logWarn('class-occurrences', 'instructor backfill failed', { locationId, trainerId, error: fillErr.message })
      continue
    }
    const { error: correctErr } = await db
      .from('class_occurrences')
      .update({ instructor: label })
      .eq('location_id', locationId)
      .neq('instructor', label)
      .gte('starts_at', backfillSinceIso)
      .eq('raw->trainers->>0', trainerId)
      .is('raw->trainers->>1', null)
    if (correctErr) {
      logWarn('class-occurrences', 'instructor correction failed', { locationId, trainerId, error: correctErr.message })
    }
  }

  return {
    ok: true, upserted, cancelled, seen: (result.events || []).length,
    trainersMapped: Object.keys(trainerNames).length, trainerLookup, trainerApiCalls,
  }
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
