// SCREENMODE.4 — ring the Hatch floor-screen boxes.
//
// A box polls its plan every PLAN_POLL_SECONDS, so a changed config would take
// up to ten minutes to show. This wakes the named boxes so they re-fetch now,
// over the same fleet doorbell channel the Pi agents use (`pingDevice`: a
// payload-free "you have work" broadcast, never throws).
//
// Both functions here are best-effort and never throw: a failed ring costs a
// delay, not a lost change, because the config is already saved.

import { pingDevice } from '@/lib/fleet-doorbell'
import { logWarn } from '@/lib/log'

/**
 * Ring each named screen, one at a time (so the realtime connections the pings
 * open are never concurrent).
 *
 * @param {string[]} deviceNames
 * @returns {Promise<number>} how many pings were sent
 */
export async function ringScreens(deviceNames) {
  let sent = 0
  for (const name of Array.isArray(deviceNames) ? deviceNames : []) {
    try {
      if ((await pingDevice(name)) === true) sent += 1
    } catch (err) {
      logWarn('screen-doorbell', 'ping threw', { deviceName: name, err: String(err) })
    }
  }
  return sent
}

/**
 * Ring every screen box linked to a TV display (fleet_devices.tv_display_id),
 * for when that display's content changes.
 *
 * @param {object} db  service-role supabase client
 * @param {string} displayId
 * @returns {Promise<number>} how many pings were sent (0 on a read error)
 */
export async function ringScreensForDisplay(db, displayId) {
  try {
    const { data, error } = await db
      .from('fleet_devices')
      .select('device_name')
      .eq('tv_display_id', displayId)
      .eq('role', 'screen')
    if (error) {
      logWarn('screen-doorbell', 'could not read the screens linked to a display', { displayId, err: error.message })
      return 0
    }
    return await ringScreens((data || []).map((r) => r.device_name))
  } catch (err) {
    logWarn('screen-doorbell', 'could not ring the screens linked to a display', { displayId, err: String(err) })
    return 0
  }
}
