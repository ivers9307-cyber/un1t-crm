// PACK-FRESHNESS.1 — Glofox pack-credit data-quality cron.
//
// Runs daily at 05:00 UTC, after glofox-attendance-refresh (04:00).
// Checks that num_classes contacts are still being synced — i.e. that
// trial_credits_remaining (which gates the churn radar's Active base
// and the pack-running-low signal) is being kept fresh.
//
// It stamps the 'glofox-data-quality' heartbeat ONLY when the data is
// fresh. A skipped stamp means the pack-credit data is going stale;
// the cron-health endpoint then surfaces it like any other stale
// cron, reusing the alerting we already have. The distinction matters
// because the glofox-attendance-refresh cron can be "alive" (its own
// heartbeat green) while the data it writes quietly rots.
//
// Auth: same CRON_SECRET pattern as the other Vercel crons.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logWarn } from '@/lib/log'
import { isPackCreditDataStale, PACK_CREDIT_MAX_AGE_DAYS } from '@/lib/glofox-data-quality'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()

  // Most-recent sync across the whole class-pack base. nullsFirst:false
  // so a contact that has actually synced sorts above never-synced ones.
  const { data, error } = await db
    .from('contacts')
    .select('glofox_synced_at')
    .eq('glofox_membership_type', 'num_classes')
    .order('glofox_synced_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  const latestSync = data?.glofox_synced_at || null
  const stale = isPackCreditDataStale(latestSync)

  if (stale) {
    // Skip the heartbeat stamp — the cron-health endpoint flagging
    // 'glofox-data-quality' as stale IS the alert.
    logWarn('glofox-data-quality',
      `pack-credit data is stale — latest num_classes sync ${latestSync || 'never'} (threshold ${PACK_CREDIT_MAX_AGE_DAYS}d)`)
    return NextResponse.json({ success: true, healthy: false, latest_pack_sync: latestSync })
  }

  await stampHeartbeat('glofox-data-quality').catch(() => {})
  return NextResponse.json({ success: true, healthy: true, latest_pack_sync: latestSync })
}
