// SHELLY-UI.5 — edit one adopted device, or remove it.
//
// NEITHER HANDLER TOUCHES A RELAY. That is the whole shape of this file:
// PATCH writes settings, DELETE writes nothing at all to the plug, and the
// physical switch stays exactly where the operator (or the last window) left
// it. Two consequences the UI has to carry rather than the code:
//
//   * DISABLING A DEVICE MID-WINDOW LEAVES IT ON. planDeviceAction's rule 2
//     returns before rule 4 can close anything — `enabled:false` means "this
//     is not mine to touch", not "switch it off" (plan.js edge d). Silently
//     leaving a plug on all night is a support ticket, so the response says
//     so in `notice` and the card repeats it. The alternative — sending an
//     explicit off on disable — was rejected: an operator turning a schedule
//     off at 06:00 to stop it firing at 07:00 would have the room go dark
//     under them.
//   * REMOVING A DEVICE DESTROYS ITS ENERGY HISTORY. shelly_energy_daily is
//     ON DELETE CASCADE from shelly_devices.id (mig 562), and because
//     (device_id, channel) is UNIQUE across the estate, moving a plug to
//     another studio is NECESSARILY remove-then-adopt. The message names the
//     loss; Task 6's two-step confirm names it before the click.
//
// locationId ALWAYS comes from withAuth's ctx, and every write pins it in the
// WHERE clause rather than reading the row back and comparing — a guessed id
// from another location must not be writable even for the instant between a
// read and a check.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { loadDevice, DEVICE_COLUMNS } from '@/lib/shelly/device-load'
import { ShellyDevicePatch } from '@/lib/shelly/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MODULE = 'shelly-device'

// The one sentence that has to survive a disable. Exported so Task 6 can
// render it without re-typing it, and so a test can assert the route and the
// card say the same thing.
export const DISABLE_NOTICE = 'Schedule switched off — the plug stays as it is until you toggle it'

const bad = (error, status, extra = {}) =>
  NextResponse.json({ success: false, error, ...extra }, { status })

// Identical body for a malformed id and a foreign one — see device-load.js.
const notFound = () => bad('Not found', 404)

/**
 * PATCH — name, enable, schedule mode, windows, class rule.
 */
export const PATCH = withAuth(
  { permission: 'device_control', schema: ShellyDevicePatch },
  async ({ db, locationId, input, params }) => {
    const loaded = await loadDevice(db, locationId, params?.id)
    if (!loaded.ok) {
      if (loaded.status === 404) return notFound()
      logError(MODULE, 'device read failed', { locationId, error: loaded.error })
      return bad('Could not load this device', 500)
    }
    const device = loaded.device

    // Read from the row as it was BEFORE this patch: `last_applied.action` is
    // the record of what WE last did to the relay, so an `on` there means the
    // schedule (or an override) is holding it on right now and switching the
    // schedule off will not release it.
    const leavesRelayOn = input.enabled === false && device.last_applied?.action === 'on'

    const { data: row, error } = await db
      .from('shelly_devices')
      .update({ ...input, updated_at: new Date().toISOString() })
      .eq('id', device.id)
      // Belt to loadDevice's braces: the tenant filter is on the WRITE, not
      // only on the read that preceded it.
      .eq('location_id', locationId)
      .select(DEVICE_COLUMNS)
      // 0 rows means the row went away between the load and the write — a
      // delete from another tab, not an error. 404 is the honest answer, and
      // `.single()` would have made it a 500.
      .maybeSingle()
    if (error) {
      if (error.code === '23514') {
        // A CHECK message echoes the offending value, so it is mapped rather
        // than surfaced. mig 562's CHECKs cover schedule_mode, channel and the
        // device id shape; the schema catches all three first, so reaching
        // here means the two have drifted.
        logError(MODULE, 'device patch failed a CHECK', { locationId, error: error.message })
        return bad('Shelly rejected one of those settings', 400)
      }
      logError(MODULE, 'device patch failed', { locationId, code: error.code, error: error.message })
      return bad('Could not save this device', 500)
    }
    if (!row) return notFound()

    return NextResponse.json({
      success: true,
      device: row,
      ...(leavesRelayOn ? { notice: DISABLE_NOTICE } : {}),
    })
  },
)

/**
 * DELETE — un-adopt. The energy history goes with it (CASCADE).
 */
export const DELETE = withAuth({ permission: 'device_control' }, async ({ db, locationId, params }) => {
  const loaded = await loadDevice(db, locationId, params?.id)
  if (!loaded.ok) {
    // IDEMPOTENT FROM THE CLIENT'S SIDE, not from the server's: a device that
    // is already gone answers 404 here, and Task 6 treats a 404 on delete as
    // "done" rather than as an error. Answering 200 for an id we never saw
    // would be the enumeration oracle the 404 exists to close.
    if (loaded.status === 404) return notFound()
    logError(MODULE, 'device read failed', { locationId, error: loaded.error })
    return bad('Could not load this device', 500)
  }

  const { error } = await db
    .from('shelly_devices')
    .delete()
    .eq('id', loaded.device.id)
    .eq('location_id', locationId)
  if (error) {
    logError(MODULE, 'device delete failed', { locationId, error: error.message })
    return bad('Could not remove this device', 500)
  }

  return NextResponse.json({
    success: true,
    message: 'Removed. Its energy history was deleted with it.',
  })
})
