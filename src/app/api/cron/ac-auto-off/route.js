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
// failure_reason and self-heal on a backoff (C7 remainder), keyed
// off updated_at (bumped by the mig 103 touch trigger on each
// failure write). AC-RETRY.1 split that backoff in two: a
// TRANSIENT failure (timeout / abort / network / rate-limit — the
// gym-floor pod not acking an OFF, which Sensibo's own history
// records as Failed/Timeout and which clears in minutes) is retried
// at the NEXT tick for up to an hour, then hourly; anything else
// stays hourly. The ops alert (org email / master-push fallback)
// is gated separately: a transient failure alerts from the 3rd
// consecutive miss, a persistent one from the 1st, and either
// repeats at most hourly — tracked on the row itself
// (auto_off_attempts / auto_off_alerted_at, mig 704) because
// failure_reason is overwritten every attempt.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { vendorTurnOff, loadDeviceWithLocation } from '@/lib/ac-devices'
import {
  failedRetryCutoffIso, buildAutoOffFailureAlert,
  FAST_RETRY_BACKOFF_MS, isTransientVendorFailure, shouldRetryFailedRow, shouldAlertFailure,
} from '@/lib/ac-auto-off'
import { sendOpsAlert } from '@/lib/ops-alerts'
import { AC_SESSION_STATUS, AC_SESSION_ACTIVE_STATUSES } from '@/lib/enums'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logWarn } from '@/lib/log'

// Statuses this cron owns. 'on' and 'extended' are the live states,
// picked up every tick; 'failed' rows are picked up separately on
// the retry backoff. The success-update guard below still checks
// against all three.
const CRON_PICKUP_STATUSES = [
  AC_SESSION_STATUS.ON, AC_SESSION_STATUS.EXTENDED, AC_SESSION_STATUS.FAILED,
]

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60
// Stop taking on new rows past this point so the function finishes on
// its own terms well inside maxDuration, even if the last row it
// started burns a full vendor timeout plus a retry.
const LOOP_BUDGET_MS = 40_000

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()

  // Find expired sessions across every location. Service-role
  // bypasses RLS — exactly what we want here. Live rows ('on' /
  // 'extended') are picked up every tick.
  const { data: liveRows, error } = await db
    .from('ac_sessions')
    .select('id, location_id, device_id, sensibo_pod_id, auto_off_at, status, started_at, auto_off_attempts, auto_off_alerted_at')
    .in('status', AC_SESSION_ACTIVE_STATUSES)
    .not('auto_off_at', 'is', null)
    .lte('auto_off_at', nowIso)
    .order('auto_off_at', { ascending: true })
    .limit(50)

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  // 'failed' rows self-heal on a backoff, not every tick. The query
  // casts the WIDE net — anything written more than the FAST backoff
  // ago — and shouldRetryFailedRow() then decides per row whether it
  // is really due: a transient failure after one tick, anything else
  // only after the hourly window. Separate query so a pile-up of
  // failed rows can never starve the live pickup out of its limit.
  const { data: failedRows, error: failedErr } = await db
    .from('ac_sessions')
    .select('id, location_id, device_id, sensibo_pod_id, auto_off_at, status, started_at, updated_at, failure_reason, auto_off_attempts, auto_off_alerted_at')
    .eq('status', AC_SESSION_STATUS.FAILED)
    .not('auto_off_at', 'is', null)
    .lte('auto_off_at', nowIso)
    .lt('updated_at', failedRetryCutoffIso(nowMs, FAST_RETRY_BACKOFF_MS))
    .order('auto_off_at', { ascending: true })
    .limit(20)

  if (failedErr) {
    return NextResponse.json({ success: false, error: failedErr.message }, { status: 500 })
  }

  const dueFailed = (failedRows || []).filter((row) => shouldRetryFailedRow(row, nowMs))
  const expired = [...(liveRows || []), ...dueFailed]
  const stats = {
    found: expired.length, off: 0, failed: 0, skipped: 0, deferred: 0,
    // Failed rows seen but not yet due under their lane's backoff.
    waiting: (failedRows || []).length - dueFailed.length,
  }

  for (const row of expired) {
    // SENSIBO-RATE.1 — vendor calls are now spaced (min 1.5s apart)
    // and 429s are retried, so a long queue of rows takes real time.
    // Stop cleanly before maxDuration rather than being killed
    // mid-row: an untracked kill would leave a row neither turned
    // off nor marked, and the count of what we skipped invisible.
    // Whatever is left is still expired on the next tick 5 min later.
    if (Date.now() - nowMs > LOOP_BUDGET_MS) {
      stats.deferred = expired.length - (stats.off + stats.failed + stats.skipped)
      logWarn('cron-ac-auto-off', 'loop budget reached — deferring the rest to the next tick', {
        deferred: stats.deferred, processed: stats.off + stats.failed + stats.skipped,
      })
      break
    }

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

    // SENSIBO-RATE.1 — never turn off a device a NEWER session owns.
    //
    // A row that failed its auto-off sticks around on the hourly
    // retry backoff, so by the time it is retried the device may
    // have been legitimately started again — by a class-climate
    // fire or by a staff member. Turning off on this row's behalf
    // would kill a session someone is actively relying on, mid-class.
    // The vendor failures of 2026-08-29..31 left three such rows
    // queued against a live session, which is how this surfaced.
    const { data: newerRows } = await db
      .from('ac_sessions')
      .select('id')
      .eq('device_id', row.device_id)
      .in('status', AC_SESSION_ACTIVE_STATUSES)
      .gt('started_at', row.started_at)
      .limit(1)
    if (newerRows?.length) {
      // Close it out so it stops being retried. The newer session
      // carries its own auto_off_at, so the device is still covered.
      await db
        .from('ac_sessions')
        .update({
          status: AC_SESSION_STATUS.AUTO_OFF,
          ended_at: nowIso,
          failure_reason: 'Superseded by a newer session for this device — closed without a vendor call.',
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
      // Vendor refused (pod did not ack, rate-limited, creds wiped…).
      // Stay in 'failed' — this write bumps updated_at (touch trigger)
      // and the attempt counter, which together pick the row's lane on
      // the next tick (see shouldRetryFailedRow).
      const attempts = (Number(row.auto_off_attempts) || 0) + 1
      const transient = isTransientVendorFailure(off.error)
      const alert = shouldAlertFailure({
        transient, attempts, alertedAt: row.auto_off_alerted_at, nowMs,
      })
      await db
        .from('ac_sessions')
        .update({
          status: AC_SESSION_STATUS.FAILED,
          failure_reason: `Auto-off failed at ${nowIso}: ${String(off.error).slice(0, 500)}`,
          auto_off_attempts: attempts,
          ...(alert ? { auto_off_alerted_at: nowIso } : {}),
        })
        .eq('id', row.id)
      stats.failed++
      logWarn('cron-ac-auto-off', `device ${row.device_id} (${loaded.device.label}) auto-off failed`, {
        err: off.error, attempts, transient, alerted: alert,
      })
      // Tell an operator the unit may still be running — but not on a
      // single transient miss: the pod recovers in minutes and the next
      // tick retries. sendOpsAlert is best-effort/never throws.
      if (alert) {
        await sendOpsAlert(buildAutoOffFailureAlert({
          device: loaded.device,
          location: loaded.location,
          failureReason: off.error,
          attempts,
          transient,
        }), { db })
      }
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
