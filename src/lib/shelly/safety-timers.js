// SHELLYTIMERS.5 — the per-studio switch for the device-side safety timers.
//
// The timers ship OFF. A studio turns them on with
// `locations.settings.shelly.safety_timers = true` once the live check has
// shown the plug reports the timer back (last_state.timer_until). Until then
// every Shelly command is exactly what it was before timers existed.
//
// `locations.settings` holds credentials, so this reads ONE json path through
// PostgREST (`settings->shelly->safety_timers`), never the column, and the
// answer is a boolean that never leaves the server. Only an explicit JSON
// `true` counts: a string "true", 1, a missing key, a failed read — all off,
// because "off" is the behaviour that was already proven in production.

import { logWarn } from '@/lib/log'

const MODULE = 'shelly-safety-timers'

// The reconcile embeds the same path under `locations` (spelled out there as a
// literal so check:select-columns reads it); keep the two in step.

export const safetyTimersOn = (value) => value === true

/**
 * Is the safety-timer switch on for this location? Never throws; a failed
 * read is logged (ids only) and answers false.
 */
export async function loadSafetyTimers(db, locationId) {
  if (!locationId) return false
  try {
    const { data, error } = await db
      .from('locations')
      .select('safety_timers:settings->shelly->safety_timers')
      .eq('id', locationId)
      .maybeSingle()
    if (error) {
      logWarn(MODULE, 'safety-timer switch unreadable — timers off for this request', { locationId, error: error.message })
      return false
    }
    return safetyTimersOn(data?.safety_timers)
  } catch (e) {
    logWarn(MODULE, 'safety-timer switch unreadable — timers off for this request', { locationId, error: String(e?.message ?? e) })
    return false
  }
}
