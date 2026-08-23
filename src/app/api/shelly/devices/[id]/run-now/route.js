// SHELLY-UI.5 — "run now": stop waiting for the next tick and make this relay
// agree with its schedule.
//
// THE TWO REFUSALS ARE DELIBERATELY DISTINCT, and this is the whole reason the
// checks sit in this order (obligation 15). runNowForDevice answers a bare
// `noop` for a device that is disabled and for one with no schedule — two
// different things an operator must do two different things about:
//
//   no_schedule  → build a schedule. (409.)
//   disabled     → turn the schedule on. (409.)
//
// no_schedule IS CHECKED FIRST, and the order matters for a device that is
// both: "turn the schedule on" is useless advice when there is no schedule to
// turn on, so the refusal names the thing the operator has to build. Both
// refusals come before the connection read and before anything reaches the
// cloud — a device nobody is managing must not spend a slot of the shared
// 1 req/sec account budget to be told so.
//
// THERE IS NO "ALREADY CORRECT" ANSWER, and SHELLY-UI.9b removed the arm that
// pretended there was. runNowForDevice plans with force:true, and under force
// planDeviceAction has exactly ONE null path: rule 2, the unmanaged device.
// Rule 1 answers for any live override, rule 3 for an active window, and rule
// 4's `if (force) return {action:'off'}` catches everything else — the whole
// point of the button is that it re-sends regardless of the exactly-once
// stamp. So a run-now on a managed device ALWAYS commands the relay, and the
// old `noop → applied:null` arm was unreachable code whose only possible
// effect was to report "already correct" for a state we had not checked.
//
// The Sonos run-now route learned the distinctness rule the same way —
// collapsing "switched off" and "no window is active right now" into one
// message points an operator debugging "run now does nothing" at the wrong
// fix.

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
    if (result.noop) {
      // Unreachable — see the header. Kept as a LOUD failure rather than
      // deleted: the two guards above already took every case the planner can
      // answer null for under force, so reaching here means the planner and
      // this route disagree about what force means. Reporting a cheerful
      // applied:null would bury that disagreement under a green tick, and an
      // operator pressing Run now would be told it worked while no relay
      // moved.
      logError(MODULE, 'run-now answered an unexpected no-op for a managed device', {
        locationId, deviceId: device.id, enabled: device.enabled, scheduleMode: device.schedule_mode,
      })
      return bad('Could not apply the schedule — nothing was sent', 500, { code: 'unexpected_noop' })
    }
    return NextResponse.json({
      success: true,
      applied: result.action,
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
