// SCREENMODE.6 — a screen box asks for its plan.
//
// GET /api/fleet/screen-plan?mode=<class_app|marketing|unknown>&version=<≤40 chars>
//     Bearer fdv_…  ->  the ScreenPlan body (see buildScreenPlan)
//
// Called by the Android TV box every poll_seconds. Each call is also the box's
// heartbeat: it stamps last_heartbeat_at plus the mode and app version the box
// says it is in, which is what the fleet page reads to show "online / in the
// right mode". The stamp is advisory and never fatal; the plan always goes out.
//
// Order: auth, rate limit, role check, device row, stamp, plan. All six boxes
// share one IP, so the limiter key is the device, not the address. A device
// that is not a screen is told 404 before anything is read or written.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifyFleetDeviceToken } from '@/lib/fleet-device-auth'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { buildScreenPlan, SCREEN_DEVICE_COLUMNS } from '@/lib/screen-plan'
import { REPORTED_MODES } from '@/lib/screen-mode'
import { logWarn, logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const LOG = 'screen-plan'
const MAX_VERSION_LENGTH = 40

export async function GET(request) {
  const db = createServerClient()
  const device = await verifyFleetDeviceToken(request, db)
  if (!device) {
    return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  }

  // Abuse limiter, keyed on the device (the boxes share one IP). Fails open
  // inside checkRateLimit: a limiter outage must not blank a studio screen.
  const limit = await checkRateLimit(db, `${LOG}:${device.device_name}`, { max: 30, windowMs: 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit)

  // Only a claimed screen has a plan. Nothing is read or written for any other
  // role, nor for a screen not yet assigned to a studio (no location_id).
  if (device.role !== 'screen' || !device.location_id) {
    return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
  }

  // The auth helper selects only three columns; the plan needs the rest.
  const { data: row, error: readError } = await db
    .from('fleet_devices')
    .select(SCREEN_DEVICE_COLUMNS)
    .eq('device_name', device.device_name)
    .eq('location_id', device.location_id) // the token already proves the studio
    .maybeSingle()
  if (readError || !row) {
    logWarn(LOG, 'device row unreadable', {
      device: device.device_name,
      error: readError ? readError.message : 'row missing',
    })
    return NextResponse.json({ ok: false, error: 'Lookup failed' }, { status: 500 })
  }

  // Heartbeat. What the box reports is untrusted: the mode must be one we
  // know, the version is capped, anything else is stored as unknown / null.
  const { searchParams } = new URL(request.url)
  const mode = searchParams.get('mode')
  const version = (searchParams.get('version') || '').trim().slice(0, MAX_VERSION_LENGTH)
  const now = new Date().toISOString()
  const { error: stampError } = await db
    .from('fleet_devices')
    .update({
      last_heartbeat_at: now,
      reported_mode: REPORTED_MODES.includes(mode) ? mode : 'unknown',
      reported_version: version || null,
      updated_at: now,
    })
    .eq('device_name', device.device_name)
  if (stampError) {
    logWarn(LOG, 'heartbeat stamp failed; plan still served', {
      device: device.device_name, error: stampError.message,
    })
  }

  // The one known throw is getAppUrl() with the env unset: a deployment fault,
  // not the box's, so it is a 500 the box retries on its next poll.
  try {
    const plan = await buildScreenPlan(db, row, { nowMs: Date.now() })
    return NextResponse.json(plan, { status: 200 })
  } catch (err) {
    logError(LOG, 'plan build failed', { device: device.device_name, message: err?.message ?? null })
    return NextResponse.json({ ok: false, error: 'Plan unavailable' }, { status: 500 })
  }
}
