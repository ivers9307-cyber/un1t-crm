// Vercel cron — every 5 minutes. Sweeps ac_sessions for rows that
// have hit auto_off_at and turns the matching Sensibo pod off.
//
// Auth: same CRON_SECRET pattern other crons use.
//
// Per-row error handling: a Sensibo blip on one location shouldn't
// stop the loop for others. Failed rows get status='failed' +
// failure_reason and stay there — the next tick will retry by
// virtue of the status filter (we re-pick 'failed' too, so the
// cron has a self-healing property until Sensibo recovers).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { turnPodOff, SensiboError } from '@/lib/sensibo'
import { AC_SESSION_STATUS } from '@/lib/enums'

// Cron picks up these statuses — 'on' and 'extended' are the live
// states; 'failed' is included so a transient Sensibo error
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
  // bypasses RLS — exactly what we want here. We include 'failed'
  // so a transient Sensibo error self-heals on the next tick.
  const { data: expired, error } = await db
    .from('ac_sessions')
    .select(`
      id, location_id, sensibo_pod_id, auto_off_at, status,
      locations:location_id(sensibo_api_key)
    `)
    .in('status', CRON_PICKUP_STATUSES)
    .not('auto_off_at', 'is', null)
    .lte('auto_off_at', nowIso)
    .order('auto_off_at', { ascending: true })
    .limit(50)

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  const stats = { found: expired?.length || 0, off: 0, failed: 0 }

  for (const row of expired || []) {
    const apiKey = row.locations?.sensibo_api_key
    if (!apiKey || !row.sensibo_pod_id) {
      // Config got wiped after the session started. Mark it ended
      // so we don't keep retrying forever.
      await db
        .from('ac_sessions')
        .update({
          status: AC_SESSION_STATUS.FAILED,
          failure_reason: 'Sensibo config missing on location at auto-off time',
          ended_at: nowIso,
        })
        .eq('id', row.id)
      stats.failed++
      continue
    }
    try {
      await turnPodOff(apiKey, row.sensibo_pod_id)
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
    } catch (e) {
      const msg = e instanceof SensiboError ? e.message : (e?.message || String(e))
      await db
        .from('ac_sessions')
        .update({
          status: AC_SESSION_STATUS.FAILED,
          failure_reason: `Auto-off failed at ${nowIso}: ${msg.slice(0, 500)}`,
        })
        .eq('id', row.id)
      stats.failed++
      console.warn(`[ac-auto-off] pod ${row.sensibo_pod_id}: ${msg}`)
    }
  }

  return NextResponse.json({ success: true, stats })
}
