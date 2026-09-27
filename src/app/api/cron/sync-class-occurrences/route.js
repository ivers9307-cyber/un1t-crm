// CLASS-CLIMATE.1 — Vercel cron, every 15 min. Refreshes the
// class_occurrences "spine" from the Glofox timetable for every
// Glofox-connected location. Service-role; service bypasses RLS.
//
// Auth: CRON_SECRET (same pattern as the other crons).
//
// Heartbeat: stamped after the loop on every run that read the locations
// list, including runs where a location's sync failed (the row watches the
// cron, not Glofox — CLASSSYNCHB.1). TRAINERCALLS.1: the stamp carries the
// run's stats as last_outcome; trainer_api_calls is 0 on every tick but the
// daily trainer-lookup tick (04:00 Dublin, src/lib/class-occurrences.js).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { glofoxCredentialsForLocation } from '@/lib/glofox'
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
  const { data: locations, error } = await db
    .from('locations')
    .select('id, name, settings')
    .filter('settings', 'cs', JSON.stringify({ glofox: {} }))
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  const connected = (locations || []).filter((l) => {
    const g = l.settings?.glofox || {}
    return g.branch_id && g.api_key && g.api_token
  })

  const stats = { locations: 0, upserted: 0, errors: 0, trainer_api_calls: 0 }
  for (const loc of connected) {
    stats.locations++
    const creds = await glofoxCredentialsForLocation(db, loc.id)
    const out = await syncOccurrencesForLocation(db, { locationId: loc.id, creds })
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
