// SHELLY-UI.5 — "run now": stop waiting for the next tick and make this relay
// agree with its schedule.
//
// THE THREE REFUSALS ARE DELIBERATELY DISTINCT, and this is the whole reason
// the checks sit in this order (obligation 15). runNowForDevice answers a bare
// `noop` for a device that is disabled, for one with no schedule, and for one
// that is simply already right — three different things an operator must do
// three different things about:
//
//   no_schedule  → build a schedule. (409.)
//   disabled     → turn the schedule on. (409.)
//   nothing_to_do→ nothing; it is already correct. (200, applied:null.)
//
// no_schedule IS CHECKED FIRST, and the order matters for a device that is
// both: "turn the schedule on" is useless advice when there is no schedule to
// turn on, so the refusal names the thing the operator has to build. Both
// refusals come before the connection read and before anything reaches the
// cloud — a device nobody is managing must not spend a slot of the shared
// 1 req/sec account budget to be told so.
//
// The Sonos run-now route learned this the same way — collapsing "switched
// off" and "no window is active right now" into one message points an operator
// debugging "run now does nothing" at the wrong fix.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError, logWarn } from '@/lib/log'
import { loadConnectionWithKey, markKeyRejected } from '@/lib/shelly/connections'
import { loadDevice, withLocationTz } from '@/lib/shelly/device-load'
import { runNowForDevice } from '@/lib/shelly/reconcile'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MODULE = 'shelly-run-now'

const bad = (error, status, extra = {}) =>
  NextResponse.json({ success: false, error, ...extra }, { status })

const notFound = () => bad('Not found', 404)

export const POST = withAuth({ permission: 'device_control' }, async ({ user, db, locationId, params }) => {
  const loaded = await loadDevice(db, locationId, params?.id)
  if (!loaded.ok) {
    if (loaded.status === 404) return notFound()
    logError(MODULE, 'device read failed', { locationId, error: loaded.error })
    return bad('Could not load this device', 500)
  }
  const device = loaded.device

  // Order is load-bearing — see the header.
  if (device.schedule_mode === 'none') {
    return bad('No schedule to apply', 409, { code: 'no_schedule' })
  }
  if (!device.enabled) {
    return bad("This device's schedule is switched off — turn it on first", 409, { code: 'disabled' })
  }

  const conn = await loadConnectionWithKey(db, locationId)
  if (!conn.ok) {
    if (conn.reason === 'not_connected') {
      return bad('Connect your Shelly account first', 409, { code: 'not_connected' })
    }
    logError(MODULE, 'connection read failed', { locationId, reason: conn.reason, error: conn.error })
    return bad('Could not read the Shelly connection', 500)
  }

  // loadConnectionWithKey selects shelly_connections alone, and the engine
  // reads the zone from conn.locations — without this graft a New York studio
  // resolves its class windows on Dublin time. See device-load.js.
  const result = await runNowForDevice(db, withLocationTz(conn.connection, user), device, {})

  if (result.ok) {
    return NextResponse.json({
      success: true,
      // A noop that reached the planner is "already correct", not "nothing
      // works" — the two refusals above already took the other two cases.
      applied: result.noop ? null : result.action,
      reason: result.reason ?? null,
    })
  }

  if (result.kind === 'auth') {
    // Only `auth` is evidence about the credential; a blip or a 429 is not.
    await markKeyRejected(db, locationId)
    return bad('Shelly rejected the stored key — re-paste it from the Shelly app', 409, { code: 'key_rejected' })
  }
  if (result.kind === 'rate_limited') {
    return bad('Shelly is busy — try again in a few seconds', 429, { code: 'rate_limited' })
  }
  if (result.kind === 'occurrences') {
    // Refused rather than forced: a class-mode device on an unreadable
    // timetable would be switched OFF on the strength of an empty day.
    logWarn(MODULE, 'occurrence read failed', { locationId, deviceId: device.id, error: result.error })
    return bad("Could not read today's timetable", 502, { code: 'occurrences' })
  }
  if (result.kind === 'bad_device') {
    logError(MODULE, 'device row cannot be commanded', { locationId, deviceId: device.id })
    return bad('This device row is incomplete — remove it and adopt it again', 500, { code: 'bad_device' })
  }
  logWarn(MODULE, 'run-now failed', {
    locationId, deviceId: device.id, kind: result.kind, statusCode: result.statusCode,
  })
  return bad('Shelly cloud did not answer — try again in a minute', 502, { code: result.kind, kind: result.kind })
})
