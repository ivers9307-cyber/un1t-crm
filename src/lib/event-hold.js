// SHELLYEVENTS.3 — how long an event held at a studio keeps that studio on,
// as ONE setting per studio (Richard, 14 Nov 2026: "this shouldn't be
// controlled per event, it should be in settings").
//
// Stored as a location_automations row, key `event_hold`, config
// `{ hold_minutes }`, saved through PUT /api/automations/event_hold like every
// other automation's config (manager+ at the studio). A studio with no row
// uses DEFAULT_EVENT_HOLD_MINUTES. The row's `enabled` flag is not read: the
// setting is a number, not a switch.
//
// Read by the Shelly timers and the climate runners through
// src/lib/shelly/studio-events.js. Pure helpers here are safe in the browser
// (the Automations card imports them); loadEventHoldMinutes is server-only by
// what it is handed (the service-role client).

export const EVENT_HOLD_KEY = 'event_hold'
export const DEFAULT_EVENT_HOLD_MINUTES = 120
export const MIN_EVENT_HOLD_MINUTES = 15
export const MAX_EVENT_HOLD_MINUTES = 1440

/** A usable hold from a stored config blob, or the default. Pure. */
export function resolveEventHoldMinutes(config) {
  const n = Number(config?.hold_minutes)
  return Number.isInteger(n) && n >= MIN_EVENT_HOLD_MINUTES && n <= MAX_EVENT_HOLD_MINUTES
    ? n
    : DEFAULT_EVENT_HOLD_MINUTES
}

/**
 * The studio's hold time. A failed read is a FAILURE, never the default: the
 * callers hold state (Shelly) or skip the events for the tick (climate) rather
 * than act on a hold time nobody set.
 *
 * @returns {Promise<{ ok: true, minutes: number } | { ok: false, error: string }>}
 */
export async function loadEventHoldMinutes(db, locationId) {
  if (!locationId) return { ok: true, minutes: DEFAULT_EVENT_HOLD_MINUTES }
  const { data, error } = await db
    .from('location_automations')
    .select('config')
    .eq('location_id', locationId)
    .eq('automation_key', EVENT_HOLD_KEY)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  return { ok: true, minutes: resolveEventHoldMinutes(data?.config) }
}
