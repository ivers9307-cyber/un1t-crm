// STUDIO-AC-EXTERNAL-RULE.1 — Vercel cron, every 5 minutes.
//
// Two responsibilities, run in a single pass per device:
//   1. RECONCILE: poll the vendor for every enabled AC device that
//      has external_auto_off_minutes set. Maintain the
//      ac_external_starts table — insert when we observe
//      vendor_on + no-active-session, clear when the unit is off
//      or a real session has taken over.
//   2. ENFORCE: any row in ac_external_starts whose expected_off_at
//      has passed gets a vendor turn-off + audit log + row delete.
//
// Why one cron instead of two: every reconcile tick already needs
// a vendor poll, and the same observation tells us whether to
// insert, leave alone, or fire. Splitting would double the vendor
// API calls for no benefit.
//
// Auth: CRON_SECRET (same pattern as /api/cron/ac-auto-off).
//
// Per-row error isolation: a vendor blip on one device must not
// stop the loop for others. Vendor failures during the poll mean
// we treat that device as "unknown" for this tick (skip — neither
// insert nor clear, neither fire); failures during turn-off keep
// the row in place so the next tick retries.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { vendorGetState, vendorTurnOff, loadDeviceWithLocation, cacheDeviceState } from '@/lib/ac-devices'
import { AC_SESSION_ACTIVE_STATUSES } from '@/lib/enums'
import {
  planExternalRule,
  upsertExternalStart,
  clearExternalStart,
} from '@/lib/ac-external-rule'
import { logAuditEvent } from '@/lib/audit'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()
  const now = new Date()
  const stats = {
    devices_checked: 0,
    inserted: 0,
    cleared: 0,
    fired: 0,
    vendor_errors: 0,
    skipped: 0,
  }

  // Pull every enabled device with the rule turned on. Cap at a
  // sensible upper bound — we run every 5 min so even at 50 devices
  // this is 1 vendor call per device per tick = nothing.
  const { data: devices, error: devicesErr } = await db
    .from('ac_devices')
    .select('id, location_id, label, provider, provider_device_id, enabled, external_auto_off_minutes')
    .eq('enabled', true)
    .not('external_auto_off_minutes', 'is', null)
    .order('id')
    .limit(200)

  if (devicesErr) {
    return NextResponse.json({ success: false, error: devicesErr.message }, { status: 500 })
  }

  for (const device of devices || []) {
    stats.devices_checked++

    // Load location so we have creds for the vendor adapter. We
    // re-use loadDeviceWithLocation (no permission check — cron is
    // system actor) which gives us the full device + location pair.
    const loaded = await loadDeviceWithLocation(device.id, db)
    if (!loaded.ok) {
      stats.skipped++
      logWarn('cron-ac-external-rule', 'device load failed', { device_id: device.id, error: loaded.error })
      continue
    }

    // Vendor poll. A failure here is observability, not a state
    // transition — we skip without inserting/clearing.
    const stateOut = await vendorGetState(loaded.device, loaded.location)
    if (!stateOut.ok) {
      stats.vendor_errors++
      logWarn('cron-ac-external-rule', 'vendor get-state failed', {
        device_id: device.id, label: device.label, error: stateOut.error,
      })
      continue
    }
    const vendorOn = stateOut.state?.on === true

    // SENSIBO-RATE.1 — this cron is the ONLY thing that needs to poll
    // the vendor on a schedule, so it is also the natural place to
    // refresh the cache the AC panel reads. Before this, the panel
    // polled the vendor itself every 30s per open card and the
    // reading taken here was discarded.
    await cacheDeviceState(db, device.id, stateOut.state)

    // Active CRM session?
    const { data: sessRows } = await db
      .from('ac_sessions')
      .select('id')
      .eq('device_id', device.id)
      .in('status', AC_SESSION_ACTIVE_STATUSES)
      .limit(1)
    const hasActiveSession = (sessRows?.length || 0) > 0

    // Existing external-start row?
    const { data: extRow } = await db
      .from('ac_external_starts')
      .select('device_id, first_seen_at, expected_off_at')
      .eq('device_id', device.id)
      .maybeSingle()

    // Decide what to do.
    const plan = planExternalRule({
      vendorOn,
      hasActiveSession,
      externalRow: extRow || null,
      externalAutoOffMinutes: device.external_auto_off_minutes,
      now,
    })

    if (plan.action === 'noop') continue

    if (plan.action === 'insert') {
      const ins = await upsertExternalStart(db, {
        deviceId: device.id,
        firstSeenAt: plan.first_seen_at,
        expectedOffAt: plan.expected_off_at,
      })
      if (ins.ok) stats.inserted++
      continue
    }

    if (plan.action === 'clear') {
      const cleared = await clearExternalStart(db, device.id)
      if (cleared.ok) stats.cleared++
      continue
    }

    if (plan.action === 'fire') {
      // Auto-off time. Turn off via vendor, log audit, then clear
      // the row. If turn-off fails (vendor down, creds wiped), we
      // leave the row in place so the next tick retries.
      const off = await vendorTurnOff(loaded.device, loaded.location)
      if (!off.ok) {
        stats.vendor_errors++
        logWarn('cron-ac-external-rule', 'turn-off failed', {
          device_id: device.id, label: device.label, error: off.error,
        })
        continue
      }

      await logAuditEvent({
        category: 'business',
        action: 'ac.external_auto_off',
        // No target.id: it maps to audit_events.target_profile_id
        // (FK → profiles), so a device UUID there kills the insert.
        target: {
          label: device.label,
          resource: `ac_device/${device.id}`,
        },
        locationId: device.location_id,
        details: {
          provider: device.provider,
          first_seen_at: plan.startedAt,
          cap_minutes: device.external_auto_off_minutes,
        },
      })

      await clearExternalStart(db, device.id)
      stats.fired++
    }
  }

  await stampHeartbeat('ac-external-rule').catch((err) =>
    logWarn('cron-ac-external-rule', 'heartbeat failed', { err }))

  return NextResponse.json({ success: true, stats })
}
