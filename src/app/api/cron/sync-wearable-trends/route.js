// GET /api/cron/sync-wearable-trends
//
// Daily cron (05:00 UTC) — pulls resting-HR / HRV / VO2max time-series
// from Open Wearables for each active Apple Health connection and upserts
// them into member_health_metrics (mig 307).
//
// Pull window per member:
//   - end   = now
//   - start = latest recorded_at already in member_health_metrics, or
//             now-90d if no prior row — so each run is an incremental sync
//             rather than a full re-pull.
//
// One try/catch per connection so one bad OW response can't abort the
// entire batch. Auth is Vercel cron bearer (CRON_SECRET).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { TREND_METRICS, samplesToMetricRows } from '@/lib/wearable-trends'
import { createOpenWearablesClient } from '@/lib/openwearables'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const PAGE = 1000
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  const nowIso = new Date().toISOString()
  const ninetyDaysAgoIso = new Date(Date.now() - NINETY_DAYS_MS).toISOString()

  let totalConnections = 0
  let totalInserted = 0

  // Paginate hr_provider_connections for apple_health + active
  for (let from = 0; ; from += PAGE) {
    const { data: connections, error } = await db
      .from('hr_provider_connections')
      .select('contact_id, provider_user_id')
      .eq('provider', 'apple_health')
      .eq('status', 'active')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)

    if (error) break
    if (!connections || connections.length === 0) break

    for (const conn of connections) {
      totalConnections++
      try {
        const { contact_id: contactId, provider_user_id: providerUserId } = conn

        // Load the contact for location_id
        const { data: contact } = await db
          .from('contacts')
          .select('id, location_id')
          .eq('id', contactId)
          .maybeSingle()
        if (!contact) continue

        // Find the latest already-stored metric to set the incremental start
        const { data: latestRow } = await db
          .from('member_health_metrics')
          .select('recorded_at')
          .eq('contact_id', contactId)
          .order('recorded_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        const startIso = latestRow?.recorded_at ?? ninetyDaysAgoIso
        const endIso = nowIso

        // Pull OW timeseries
        const client = createOpenWearablesClient()
        const samples = await client.getTimeseries({
          userId: providerUserId,
          types: TREND_METRICS,
          startIso,
          endIso,
        })

        // Map to DB rows
        const rows = samplesToMetricRows({
          contactId,
          locationId: contact.location_id,
          samples,
        })

        if (rows.length > 0) {
          await db
            .from('member_health_metrics')
            .upsert(rows, { onConflict: 'contact_id,metric,recorded_at' })
          totalInserted += rows.length
        }
      } catch {
        // Best-effort per connection — one OW error must not abort the batch
      }
    }

    if (connections.length < PAGE) break
  }

  await stampHeartbeat('sync-wearable-trends').catch(() => {})
  return NextResponse.json({ success: true, connections: totalConnections, inserted: totalInserted })
}
