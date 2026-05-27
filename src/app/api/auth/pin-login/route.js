// STUDIO-PIN.2 — POST /api/auth/pin-login
//
// The PIN entry point for studio devices (Mac shell, paired iPads).
// Validates every layer of the studio-device gate, in order:
//
//   1. Body shape — Zod
//   2. Device token — paired and not revoked
//   3. Trusted IP   — source IP is in the location's CIDR list
//   4. Device lock  — 5-strikes-in-15-min cooldown not active
//   5. PIN match    — finds the staffer by PIN-hash comparison
//
// Every attempt — success or failure — writes one row to
// pin_login_attempts. That table drives both the per-device lockout
// counter (read on the next attempt) and the admin "recent activity"
// view at /admin/studio-devices (built in PR 0.2 alongside this route).
//
// Session issuance (issuing a Supabase session cookie or a custom JWT
// the client can use) is deferred to PR 0.3 — that PR also builds the
// idle-timer + PIN-overlay component and decides whether we go custom
// JWT or use Supabase's session-minting primitive. This route's job
// for PR 0.2 is to gate-keep correctly and produce the audit row;
// downstream PRs will wire up the actual session.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { findProfileByPin, isValidPinFormat } from '@/lib/studio-pin'
import {
  findDeviceByToken,
  getDeviceLockoutState,
} from '@/lib/studio-devices'
import {
  extractClientIp,
  isTrustedIpForLocation,
} from '@/lib/trusted-ips'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PIN body validation is on top of isValidPinFormat. Keep the 4-digit
// rule in one place — Zod's refine() lets us reuse the predicate so
// "what counts as a valid PIN" lives in studio-pin.js.
const Body = z.object({
  device_token: z.string().min(16).max(256),
  pin: z.string().refine(isValidPinFormat, 'PIN must be exactly 4 digits'),
})

async function logAttempt(db, {
  deviceId, sourceIp, outcome, matchedProfile, userAgent,
}) {
  try {
    await db.from('pin_login_attempts').insert({
      device_id: deviceId,
      source_ip: sourceIp,
      outcome,
      matched_profile: matchedProfile,
      user_agent: userAgent,
    })
  } catch (err) {
    // Audit failures must NOT block the actual response. Log + carry on.
    logWarn('pin-login', 'attempt log failed', { err })
  }
}

export async function POST(request) {
  // -- 0. Source IP must be discoverable. No IP, no PIN flow.
  const sourceIp = extractClientIp(request)
  if (!sourceIp) {
    return NextResponse.json(
      { success: false, error: 'Could not determine source IP' },
      { status: 400 },
    )
  }
  const userAgent = request.headers.get('user-agent')?.slice(0, 500) || null
  const db = createServerClient()

  // -- 1. Body shape.
  const validation = await validateBody(request, Body)
  if (!validation.ok) return validation.response
  const { device_token, pin } = validation.data

  // -- 2. Device token must resolve to a paired, non-revoked device.
  let device
  try {
    device = await findDeviceByToken({ db, token: device_token })
  } catch (err) {
    logWarn('pin-login', 'device lookup failed', { err })
    return NextResponse.json(
      { success: false, error: 'Server error' },
      { status: 500 },
    )
  }
  if (!device) {
    await logAttempt(db, {
      deviceId: null, sourceIp, outcome: 'unknown_device',
      matchedProfile: null, userAgent,
    })
    // Don't reveal which gate failed — same message as wrong PIN /
    // wrong IP / locked device. An attacker should learn nothing
    // from the response shape.
    return NextResponse.json(
      { success: false, error: 'Not allowed' },
      { status: 403 },
    )
  }

  // -- 3. Trusted-IP check, scoped to the device's location.
  let ipOk
  try {
    ipOk = await isTrustedIpForLocation({
      db, locationId: device.location_id, sourceIp,
    })
  } catch (err) {
    logWarn('pin-login', 'trusted-ip check failed', { err })
    return NextResponse.json(
      { success: false, error: 'Server error' },
      { status: 500 },
    )
  }
  if (!ipOk) {
    await logAttempt(db, {
      deviceId: device.id, sourceIp, outcome: 'untrusted_ip',
      matchedProfile: null, userAgent,
    })
    return NextResponse.json(
      { success: false, error: 'Not allowed' },
      { status: 403 },
    )
  }

  // -- 4. Per-device lockout. Check BEFORE the PIN match so a locked
  //       device can't keep adding wrong_pin rows to the window.
  let lockState
  try {
    lockState = await getDeviceLockoutState({ db, deviceId: device.id })
  } catch (err) {
    logWarn('pin-login', 'lockout check failed', { err })
    return NextResponse.json(
      { success: false, error: 'Server error' },
      { status: 500 },
    )
  }
  if (lockState.locked) {
    await logAttempt(db, {
      deviceId: device.id, sourceIp, outcome: 'device_locked',
      matchedProfile: null, userAgent,
    })
    return NextResponse.json(
      { success: false, error: 'Device temporarily locked. Try again in a few minutes.', retry_after: lockState.retryAfter },
      { status: 429 },
    )
  }

  // -- 5. PIN match across all active profiles. PIN uniqueness means
  //       at most one match. findProfileByPin throws if a misconfig
  //       has more than safetyCap profiles holding live PINs.
  let matched
  try {
    matched = await findProfileByPin({ db, pin })
  } catch (err) {
    logWarn('pin-login', 'pin match failed', { err })
    return NextResponse.json(
      { success: false, error: 'Server error' },
      { status: 500 },
    )
  }
  if (!matched) {
    await logAttempt(db, {
      deviceId: device.id, sourceIp, outcome: 'wrong_pin',
      matchedProfile: null, userAgent,
    })
    return NextResponse.json(
      { success: false, error: 'Not allowed' },
      { status: 403 },
    )
  }

  // -- Success. Stamp last_seen_at on the device + write the audit row.
  // Both are fire-and-forget — failures don't block the response.
  try {
    await db.from('studio_devices')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', device.id)
  } catch (err) {
    logWarn('pin-login', 'last_seen_at update failed', { err })
  }

  // Pull the staffer's home_screen_path so the client knows where to
  // navigate after PIN unlock. Single read; minor extra latency vs
  // baking it into findProfileByPin, traded for keeping that helper
  // focused on the match.
  const { data: profile } = await db
    .from('profiles')
    .select('home_screen_path')
    .eq('id', matched.id)
    .single()

  await logAttempt(db, {
    deviceId: device.id, sourceIp, outcome: 'success',
    matchedProfile: matched.id, userAgent,
  })

  return NextResponse.json({
    success: true,
    profile: {
      id: matched.id,
      full_name: matched.full_name,
      home_screen_path: profile?.home_screen_path || '/dashboard',
    },
    // Session minting is deferred to PR 0.3. For now the client
    // receives confirmation that the gate-keeping passed; PR 0.3
    // will extend this response to include the session token /
    // cookie material once the session-cookie mechanism is decided.
    device: {
      id: device.id,
      kind: device.device_kind,
      label: device.label,
      location_id: device.location_id,
    },
  })
}
