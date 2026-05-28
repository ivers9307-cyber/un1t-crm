// Vercel cron — every 5 minutes. Sweeps ac_sessions for rows that
// have hit auto_off_at and turns off the linked AC device.
//
// STUDIO-AC-DEVICES.2 — refactored to dispatch by provider.
// Originally this loop assumed every session was Sensibo-backed
// and called turnPodOff directly. With LG ThinQ in the mix the
// cron has to read each session's linked ac_devices row and call
// the right vendor. The dispatch happens via vendorTurnOff from
// src/lib/ac-devices.js — a pure vendor power-off with no
// permission check (system actor; we already know the session
// was created legitimately).
//
// Auth: CRON_SECRET, same pattern other crons use.
//
// Per-row error handling: a vendor blip on one device shouldn't
// stop the loop for others. Failed rows get status='failed' +
// failure_reason and stay there — the next tick re-picks 'failed'
// rows, so the cron has a self-healing property until the vendor
// recovers.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { vendorTurnOff, loadDeviceWithLocation } from '@/lib/ac-devices'
import { AC_SESSION_STATUS } from '@/lib/enums'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logWarn } from '@/lib/log'

// Cron picks up these statuses — 'on' and 'extended' are the live
// states; 'failed' is included so a transient vendor error
// self-heals on the next tick.
const CRON_PICKUP_STATUSES = [
  AC_SESSION_STATUS.ON, AC_SESSION_STATUS.EXTENDED, AC_SESSION_STATUS.FAILED,
]

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()
  const nowIso = new Date().toISOString()

  // Find expired sessions across every location. Service-role
  // bypasses RLS — exactly what we want here. Include 'failed' so
  // a transient vendor error self-heals on the next tick.
  const { data: expired, error } = await db
    .from('ac_sessions')
    .select('id, location_id, device_id, sensibo_pod_id, auto_off_at, status')
    .in('status', CRON_PICKUP_STATUSES)
    .not('auto_off_at', 'is', null)
    .lte('auto_off_at', nowIso)
    .order('auto_off_at', { ascending: true })
    .limit(50)

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  const stats = { found: expired?.length || 0, off: 0, failed: 0, skipped: 0 }

  for (const row of expired || []) {
    if (!row.device_id) {
      // Legacy session with no device link (pre-mig 210 and the
      // backfill didn't match — should be vanishingly rare). Mark
      // it ended so we stop retrying forever; an operator can
      // investigate from /admin/audit-log if they care.
      await db
        .from('ac_sessions')
        .update({
          status: AC_SESSION_STATUS.FAILED,
          failure_reason: 'No device_id linked — likely a legacy session that pre-dates mig 210.',
          ended_at: nowIso,
        })
        .eq('id', row.id)
      stats.skipped++
      continue
    }

    const loaded = await loadDeviceWithLocation(row.device_id, db)
    if (!loaded.ok) {
      await db
        .from('ac_sessions')
        .update({
          status: AC_SESSION_STATUS.FAILED,
          failure_reason: `Device lookup failed at auto-off: ${loaded.error}`,
          ended_at: nowIso,
        })
        .eq('id', row.id)
      stats.failed++
      continue
    }

    const off = await vendorTurnOff(loaded.device, loaded.location)
    if (!off.ok) {
      // Vendor refused (offline, rate-limited, creds wiped, etc.).
      // Stay in 'failed' so the next tick retries.
      await db
        .from('ac_sessions')
        .update({
          status: AC_SESSION_STATUS.FAILED,
          failure_reason: `Auto-off failed at ${nowIso}: ${String(off.error).slice(0, 500)}`,
        })
        .eq('id', row.id)
      stats.failed++
      console.warn(`[ac-auto-off] device ${row.device_id} (${loaded.device.label}): ${off.error}`)
      continue
    }

    await db
      .from('ac_sessions')
      .update({
        status: AC_SESSION_STATUS.AUTO_OFF,
        ended_at: new Date().toISOString(),
        failure_reason: null,
      })
      .eq('id', row.id)
      .in('status', CRON_PICKUP_STATUSES)
    stats.off++
  }

  await stampHeartbeat('ac-auto-off').catch((err) =>
    logWarn('cron-ac-auto-off', 'heartbeat failed', { err }))

  return NextResponse.json({ success: true, stats })
}
