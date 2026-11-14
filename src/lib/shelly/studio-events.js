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
// WHEN: an event has start times (its race_waves rows, else its own
// start_time) and almost never a length (duration_minutes was NULL on every
// event in prod when this was written). It runs from its FIRST start time to
// `duration_minutes` after its LAST one, DEFAULT_EVENT_MINUTES when unset.
// An event with no start time at all gives no span: there is nothing to hold
// the studio on FOR, and guessing a whole day would defeat the timer.
//
// A FAILED READ IS NOT "NO EVENTS": loadDayEvents answers { ok: false } and
// loadDayOccurrences passes that on, so the tick skips class devices (holds
// their state) instead of switching a studio off mid-event on a database blip.
import { zonedWallClockToInstant } from '@/lib/location-time'
import { logWarn } from '@/lib/log'

const MODULE = 'shelly-studio-events'

/** How long an event with no duration_minutes is taken to run after its last start time. */
export const DEFAULT_EVENT_MINUTES = 120

// Several times any real day. The sentinel row (cap + 1) tells "exactly at
// the cap" from "the limit dropped the rest", like every select in reconcile.
export const MAX_DAY_EVENTS = 50

const EVENT_COLUMNS = 'id, name, race_date, start_time, duration_minutes, waves:race_waves ( start_time )'

/**
 * One event row → one occurrence-shaped span, or null when it has no usable
 * start time. Pure.
 *
 * @param event { name, race_date, start_time, duration_minutes, waves: [{ start_time }] }
 * @param tz the STUDIO's zone (the one the timers run on)
 * @returns {{ starts_at, ends_at, cancelled_at: null, name, kind: 'event' } | null}
 */
export function eventToOccurrence(event, tz) {
  if (!event?.race_date) return null
  const times = (Array.isArray(event.waves) ? event.waves : []).map((w) => w?.start_time)
  if (!times.some(Boolean)) times.push(event.start_time)
  const starts = times
    .map((t) => (t ? zonedWallClockToInstant(event.race_date, String(t), tz) : null))
    .filter((ms) => Number.isFinite(ms))
  if (!starts.length) return null
  const mins = Number(event.duration_minutes)
  const runMs = (Number.isFinite(mins) && mins > 0 ? mins : DEFAULT_EVENT_MINUTES) * 60 * 1000
  return {
    starts_at: new Date(Math.min(...starts)).toISOString(),
    ends_at: new Date(Math.max(...starts) + runMs).toISOString(),
    cancelled_at: null,
    name: event.name ?? null,
    kind: 'event',
  }
}

/**
 * The events held at `locationId` on the local day `dayStr`, as occurrences.
 *
 * @returns {{ok: true, occurrences: Array} | {ok: false, error: string}}
 */
export async function loadDayEvents(db, locationId, tz, dayStr) {
  if (!locationId) return { ok: true, occurrences: [] }
  const { data, error } = await db
    .from('race_events')
    .select(EVENT_COLUMNS)
    .eq('race_date', dayStr)
    .eq('active', true)
    .eq('status', 'published')
    // Held here: said so explicitly, or the studio's own event with no venue link.
    .or(`venue_location_id.eq.${locationId},and(location_id.eq.${locationId},host_id.is.null,venue_location_id.is.null)`)
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
