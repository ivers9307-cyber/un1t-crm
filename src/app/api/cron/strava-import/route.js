import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { loadStravaConfig, backfillConnection } from '@/lib/strava-import'

export const runtime = 'nodejs'
export const maxDuration = 300

const BACKFILL_DAYS = 30

export async function GET(request) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  const db = createServerClient()
  const config = await loadStravaConfig(db)
  if (!config?.isEnabled) { await stampHeartbeat('strava-import'); return NextResponse.json({ success: true, skipped: 'not_configured' }) }

  // Connections that have the read scope but haven't been backfilled yet.
  const { data: pending } = await db
    .from('contact_external_integrations')
    .select('id, contact_id, external_athlete_id, access_token, refresh_token, expires_at, scopes')
    .eq('provider', 'strava')
    .is('disconnected_at', null)
    .is('import_backfilled_at', null)
    .limit(50)

  const sinceMs = Date.now() - BACKFILL_DAYS * 24 * 3600 * 1000
  let done = 0
  for (const connection of pending || []) {
    const hasRead = (connection.scopes || []).some((s) => s === 'activity:read' || s === 'activity:read_all')
    if (!hasRead) continue
    try {
      await backfillConnection(db, { connection, config, sinceMs })
      await db.from('contact_external_integrations').update({ import_backfilled_at: new Date().toISOString() }).eq('id', connection.id)
      done += 1
    } catch (e) {
      console.warn(`[cron strava-import] backfill failed for ${connection.id}: ${e?.message || e}`)
    }
  }
  await stampHeartbeat('strava-import')
  return NextResponse.json({ success: true, backfilled_connections: done })
}
