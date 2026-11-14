// SHELLYEVENTS.1 — the events HELD AT a studio on one local day, shaped like
// class occurrences so the schedule engine (src/lib/schedule/desired-state.js)
// treats an event exactly like a class: on `lead_min` before, off `lag_min`
// after, gaps bridged.
//
// WHY: class mode followed only the class timetable (class_occurrences), so a
// studio hosting an event with no class on switched off mid-event (Richard,
// 14 Nov 2026).
//
// WHICH EVENTS (mig 832):
//   * race_events.venue_location_id = this studio. That is how a HOST's event
//     (Pride Training Club: filed under the host's anchor location) says it is
//     held here. The host's free-text venue_name is never matched: a new
//     spelling would silently switch the studio off.
//   * the studio's OWN events (location_id = this studio, host_id NULL) with no
//     venue_location_id: a studio's own event is held at the studio.
//   * published, active, dated on this local day. A draft, a rejected or a
//     switched-off event is not happening.
//
//   * not held_offsite (mig 833): staff's way to say a studio's own event is
//     somewhere else.
//
// WHEN: an event has start times (its race_waves rows, else its own
// start_time). It runs from its FIRST start time to holdMinutes() after its
// LAST one: studio_hold_minutes (mig 833, staff-only), else duration_minutes
// (customer-facing: the calendar entry's length), else DEFAULT_EVENT_MINUTES.
// The two are separate columns so that holding a studio on for 3 hours never
// tells an attendee their session is 3 hours long.
//
// TWO SHAPES. The Shelly timers want ONE span per event (eventToOccurrence).
// The climate automations act per class START (bathroom fans run N minutes
// after a start), so they get one span per SESSION (loadEventSessionsBetween),
// each keyed `event:<id>:<HH:MM>` where a class carries its glofox_event_id.
// An event with no start time at all gives no span: there is nothing to hold
// the studio on FOR, and guessing a whole day would defeat the timer.
//
// A FAILED READ IS NOT "NO EVENTS": loadDayEvents answers { ok: false } and
// loadDayOccurrences passes that on, so the tick skips class devices (holds
// their state) instead of switching a studio off mid-event on a database blip.
import { zonedWallClockToInstant, strictDayStrIn } from '@/lib/location-time'
import { logWarn } from '@/lib/log'

const MODULE = 'shelly-studio-events'

/** How long an event with no hold and no duration runs after its last start time. */
export const DEFAULT_EVENT_MINUTES = 120

// Several times any real day. The sentinel row (cap + 1) tells "exactly at
// the cap" from "the limit dropped the rest", like every select in reconcile.
export const MAX_DAY_EVENTS = 50

const EVENT_COLUMNS = 'id, name, race_date, start_time, duration_minutes, studio_hold_minutes, waves:race_waves ( start_time )'

const positive = (v) => {
  const n = Number(v)
  return v != null && Number.isFinite(n) && n > 0 ? n : null
}

/** Minutes the studio is held on after an event's last start time. Pure. */
export function holdMinutes(event) {
  return positive(event?.studio_hold_minutes) ?? positive(event?.duration_minutes) ?? DEFAULT_EVENT_MINUTES
}

// The event's start instants (ms), in time order, with their HH:MM. [] when it
// has no date or no usable start time.
function sessionStarts(event, tz) {
  if (!event?.race_date) return []
  const times = (Array.isArray(event.waves) ? event.waves : []).map((w) => w?.start_time)
  if (!times.some(Boolean)) times.push(event.start_time)
  const out = []
  for (const t of times) {
    if (!t) continue
    const ms = zonedWallClockToInstant(event.race_date, String(t), tz)
    if (Number.isFinite(ms)) out.push({ ms, hhmm: String(t).slice(0, 5) })
  }
  return out.sort((a, b) => a.ms - b.ms)
}

/**
 * One event row → one occurrence-shaped span, or null when it has no usable
 * start time. Pure.
 *
 * @param event { name, race_date, start_time, duration_minutes, studio_hold_minutes, waves: [{ start_time }] }
 * @param tz the STUDIO's zone (the one the timers run on)
 * @returns {{ starts_at, ends_at, cancelled_at: null, name, kind: 'event' } | null}
 */
export function eventToOccurrence(event, tz) {
  const starts = sessionStarts(event, tz)
  if (!starts.length) return null
  return {
    starts_at: new Date(starts[0].ms).toISOString(),
    ends_at: new Date(starts[starts.length - 1].ms + holdMinutes(event) * 60 * 1000).toISOString(),
    cancelled_at: null,
    name: event.name ?? null,
    kind: 'event',
  }
}

/**
 * One event row → one span per SESSION, shaped like the class rows the climate
 * runners read (`glofox_event_id` is their idempotency key). Pure.
 */
export function eventToSessions(event, tz) {
  const runMs = holdMinutes(event) * 60 * 1000
  return sessionStarts(event, tz).map(({ ms, hhmm }) => ({
    glofox_event_id: `event:${event.id}:${hhmm}`,
    name: event.name ?? null,
    starts_at: new Date(ms).toISOString(),
    ends_at: new Date(ms + runMs).toISOString(),
    kind: 'event',
  }))
}

// The shared read: published, active, on-site events held at the studio on a
// local day or range of days.
function heldAtStudio(db, locationId) {
  return db
    .from('race_events')
    .select(EVENT_COLUMNS)
    .eq('active', true)
    .eq('status', 'published')
    .eq('held_offsite', false)
    // Held here: said so explicitly, or the studio's own event with no venue link.
    .or(`venue_location_id.eq.${locationId},and(location_id.eq.${locationId},host_id.is.null,venue_location_id.is.null)`)
}

/**
 * The events held at `locationId` on the local day `dayStr`, as occurrences.
 *
 * @returns {{ok: true, occurrences: Array} | {ok: false, error: string}}
 */
export async function loadDayEvents(db, locationId, tz, dayStr) {
  if (!locationId) return { ok: true, occurrences: [] }
  const { data, error } = await heldAtStudio(db, locationId)
    .eq('race_date', dayStr)
    .order('id')
    .limit(MAX_DAY_EVENTS + 1)
  if (error) return { ok: false, error: error.message }
  let rows = data || []
  if (rows.length > MAX_DAY_EVENTS) {
    logWarn(MODULE, 'event cap exceeded, excess events skipped', { locationId, dayStr, cap: MAX_DAY_EVENTS })
    rows = rows.slice(0, MAX_DAY_EVENTS)
  }
  const occurrences = []
  for (const row of rows) {
    const occ = eventToOccurrence(row, tz)
    if (occ) occurrences.push(occ)
    else logWarn(MODULE, 'event has no start time, not counted by the timers', { locationId, eventId: row?.id })
  }
  return { ok: true, occurrences }
}

/**
 * The event SESSIONS held at `locationId` that start between two instants,
 * for the climate runners (class-climate, bathroom-climate).
 *
 * @returns {{ok: true, occurrences: Array} | {ok: false, error: string}}
 */
export async function loadEventSessionsBetween(db, locationId, tz, sinceMs, untilMs) {
  if (!locationId) return { ok: true, occurrences: [] }
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs)) return { ok: false, error: 'unusable window' }
  const { data, error } = await heldAtStudio(db, locationId)
    .gte('race_date', strictDayStrIn(sinceMs, tz))
    .lte('race_date', strictDayStrIn(untilMs, tz))
    .order('id')
    .limit(MAX_DAY_EVENTS + 1)
  if (error) return { ok: false, error: error.message }
  const rows = (data || []).slice(0, MAX_DAY_EVENTS)
  if ((data || []).length > MAX_DAY_EVENTS) {
    logWarn(MODULE, 'event cap exceeded, excess events skipped', { locationId, cap: MAX_DAY_EVENTS })
  }
  const occurrences = rows
    .flatMap((row) => eventToSessions(row, tz))
    .filter((o) => {
      const ms = new Date(o.starts_at).getTime()
      return ms >= sinceMs && ms <= untilMs
    })
    .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime())
  return { ok: true, occurrences }
}
