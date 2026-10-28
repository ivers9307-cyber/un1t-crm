// SHELLY-UI.5 — edit one adopted device, or remove it.
//
// NEITHER HANDLER TOUCHES A RELAY. That is the whole shape of this file:
// PATCH writes settings, DELETE writes nothing at all to the plug, and the
// physical switch stays exactly where the operator (or the last window) left
// it. Two consequences the UI has to carry rather than the code:
//
//   * UN-MANAGING A DEVICE MID-WINDOW LEAVES IT ON. planDeviceAction's rule 2
//     returns before rule 4 can close anything — `enabled:false` OR
//     `schedule_mode:'none'` means "this is not mine to touch", not "switch it
//     off" (plan.js edge d). BOTH arms of that rule get the notice: clearing
//     the schedule on an enabled device abandons the relay just as completely
//     as switching the schedule off. Silently leaving a plug on all night is a
//     support ticket, so the response says so in `notice` and both the card's
//     enable toggle and the schedule editor repeat it. The alternative —
//     sending an explicit off — was rejected: an operator turning a schedule
//     off at 06:00 to stop it firing at 07:00 would have the room go dark
//     under them.
//   * REMOVING A DEVICE DESTROYS ITS ENERGY HISTORY. shelly_energy_daily is
//     ON DELETE CASCADE from shelly_devices.id (mig 562), and because
//     (device_id, channel) is UNIQUE across the estate, moving a plug to
//     another studio is NECESSARILY remove-then-adopt. The message names the
//     loss; Task 6's two-step confirm names it before the click.
//   * A GROUPED DEVICE'S SCHEDULE IS LOCKED (SHELLYGROUPS.5). While a device
//     is in a group the GROUP's enabled and schedule govern it
//     (effectiveTarget), so its own `enabled`, `schedule_mode`,
//     `fixed_windows` and `class_rule` are invisible — and they would come
//     back to life the moment it left the group. The spec rule is that leaving
//     a group can never revive a stale, invisible schedule: joining clears the
//     device's schedule, and this route refuses to write one back while it is
//     grouped (409 `grouped`). A rename is still fine.
//
// locationId ALWAYS comes from withAuth's ctx, and every write pins it in the
// WHERE clause rather than reading the row back and comparing — a guessed id
// from another location must not be writable even for the instant between a
// read and a check.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { loadDevice, DEVICE_COLUMNS, requestTz } from '@/lib/shelly/device-load'
import { withSafetyTimerNotice } from '@/lib/shelly/safety-notice'
import { ShellyDevicePatch } from '@/lib/shelly/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MODULE = 'shelly-device'

// The one sentence that has to survive a disable. Exported so Task 6 can
// render it without re-typing it, and so a test can assert the route and the
// card say the same thing.
export const DISABLE_NOTICE = 'Schedule switched off — the plug stays as it is until you toggle it'
// SHELLYTIMERS.6: when the relay we switched on carries a safety timer (an
// armed cap_at, or a running timer the plug reported), that "stays as it is"
// holds only until the timer, so the notice gains one sentence saying when
// (withSafetyTimerNotice, in the studio's zone).

// The refusal for a schedule edit on a grouped device (see the header).
export const GROUPED_MESSAGE =
  "This device follows its group's schedule — change the group, or take the device out of the group first"
const SCHEDULE_FIELDS = ['enabled', 'schedule_mode', 'fixed_windows', 'class_rule']

const bad = (error, status, extra = {}) =>
  NextResponse.json({ success: false, error, ...extra }, { status })

// Identical body for a malformed id and a foreign one — see device-load.js.
const notFound = () => bad('Not found', 404)

/**
 * PATCH — name, enable, schedule mode, windows, class rule.
 */
export const PATCH = withAuth(
  { permission: 'device_control', schema: ShellyDevicePatch },
  async ({ user, db, locationId, input, params }) => {
    const loaded = await loadDevice(db, locationId, params?.id)
    if (!loaded.ok) {
      if (loaded.status === 404) return notFound()
      logError(MODULE, 'device read failed', { locationId, error: loaded.error })
      return bad('Could not load this device', 500)
    }
    const device = loaded.device

    if (device.group_id && SCHEDULE_FIELDS.some((f) => input[f] !== undefined)) {
      return bad(GROUPED_MESSAGE, 409, { code: 'grouped' })
    }

    // Read from the row as it was BEFORE this patch: `last_applied.action` is
    // the record of what WE last did to the relay, so an `on` there means the
    // schedule (or an override) is holding it on right now and whatever stops
    // this device being managed will not release it.
    //
    // BOTH WAYS OUT OF "MANAGED" COUNT (SHELLY-UI.9b). planDeviceAction's rule
    // 2 is `!enabled || schedule_mode === 'none'` — one condition with two
    // arms — so setting the mode to 'none' on an ENABLED device abandons the
    // relay exactly as thoroughly as switching the schedule off does, and the
    // notice used to fire for only one of them. An operator clearing a
    // schedule in the editor got no warning at all that the plug they were
    // about to stop managing was on and would stay on.
    const stopsManaging = input.enabled === false || input.schedule_mode === 'none'
    const leavesRelayOn = stopsManaging && device.last_applied?.action === 'on'

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
      ...(leavesRelayOn ? { notice: withSafetyTimerNotice(DISABLE_NOTICE, [device], Date.now(), requestTz(user), 'It') } : {}),
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
