// CLASS-CLIMATE.1 — Vercel cron, every 15 min. Refreshes the
// class_occurrences "spine" from the Glofox timetable for every
// Glofox-connected location. Service-role; service bypasses RLS.
//
// Auth: CRON_SECRET (same pattern as the other crons).

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

  const stats = { locations: 0, upserted: 0, errors: 0 }
  for (const loc of connected) {
    stats.locations++
    const creds = await glofoxCredentialsForLocation(db, loc.id)
    const out = await syncOccurrencesForLocation(db, { locationId: loc.id, creds })
    if (out.ok) {
      stats.upserted += out.upserted
    } else {
      stats.errors++
      logWarn('cron-sync-class-occurrences', 'sync failed', { locationId: loc.id, error: out.error })
    }
  }

  await stampHeartbeat('sync-class-occurrences').catch((err) =>
    logWarn('cron-sync-class-occurrences', 'heartbeat failed', { err }))
  return NextResponse.json({ success: true, stats })
}
