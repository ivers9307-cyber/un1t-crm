// CLASS-CLIMATE.1 — Vercel cron, every 15 min. Refreshes the
// class_occurrences "spine" from the Glofox timetable for every
// Glofox-connected location. Service-role; service bypasses RLS.
//
// Auth: CRON_SECRET (same pattern as the other crons).
//
// Heartbeat: stamped after the loop on every run that read the locations
// list, including runs where a location's sync failed, so a Glofox that
// ANSWERS with an error does not page. One that HANGS or RATE-LIMITS past
// the 60 s maxDuration kills the tick before its stamp, so it does (mig 644,
// CLASSSYNCHB.1). TRAINERCALLS.1: the stamp carries the
// run's stats as last_outcome; trainer_api_calls is 0 on every tick but the
// daily trainer-lookup tick (04:00 Dublin, src/lib/class-occurrences.js).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { glofoxCredentialsForLocation } from '@/lib/glofox'
import { locationsWithSource } from '@/lib/membership/locations-for-source'
import { syncOccurrencesForLocation } from '@/lib/class-occurrences'
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
  // W1.M3b — discovery through the membership seam (active locations whose
  // membership_source is 'glofox' and whose provider is configured), never
  // the settings slice. A failed seam read is a 500 with no heartbeat.
  const { eligible: connected, skipped, error } = await locationsWithSource(db, 'glofox', { module: 'cron-sync-class-occurrences' })
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  const stats = { locations: 0, upserted: 0, errors: 0, trainer_api_calls: 0, reconcile_errors: 0, skipped: skipped.length }
  for (const loc of connected) {
    stats.locations++
    const creds = await glofoxCredentialsForLocation(db, loc.id)
    if (creds.readError) {
      // REGISTRYREAD.1b: don't call Glofox with null credentials; counted as
      // an error like any failed sync (the stamp below is unchanged) and the
      // next 15-minute tick retries.
      stats.errors++
      logWarn('cron-sync-class-occurrences', 'glofox settings unreadable; skipped this tick', { locationId: loc.id })
      continue
    }
    const out = await syncOccurrencesForLocation(db, { locationId: loc.id, creds })
    // CRONREADERR.1 — this studio's cancellation step could not finish (its
    // read or its UPDATE failed); nothing was cancelled. Counted, never fatal:
    // the next studio still syncs and the stamp below is unchanged.
    if (out.reconcileFailed) stats.reconcile_errors++
    stats.trainer_api_calls += Number(out.trainerApiCalls) || 0
    if (out.ok) {
      stats.upserted += out.upserted
    } else {
      stats.errors++
      logWarn('cron-sync-class-occurrences', 'sync failed', { locationId: loc.id, error: out.error })
    }
  }

  await stampHeartbeat('sync-class-occurrences', stats).catch((err) =>
    logWarn('cron-sync-class-occurrences', 'heartbeat failed', { err }))
  return NextResponse.json({ success: true, stats })
}
