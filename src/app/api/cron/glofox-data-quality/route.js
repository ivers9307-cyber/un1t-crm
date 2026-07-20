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
import { stampTenantHeartbeat } from '@/lib/tenant-heartbeat'
import { sendOpsAlert } from '@/lib/ops-alerts'
import { logWarn } from '@/lib/log'
import { isPackCreditDataStale, PACK_CREDIT_MAX_AGE_DAYS } from '@/lib/glofox-data-quality'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()

  // SAAS4-O1 — per-LOCATION freshness. The pre-412 version computed ONE
  // global most-recent sync, so one healthy tenant's sync masked another
  // tenant's rot. Now: evaluate each active location's own pack base.
  // Locations with zero num_classes contacts are skipped entirely (not
  // Glofox-connected, or no packs sold) — never a false stale.
  const { data: locations, error: locErr } = await db
    .from('locations')
    .select('id, name, organization_id')
    .eq('active', true)
  if (locErr) {
    return NextResponse.json({ success: false, error: locErr.message }, { status: 500 })
  }

  const perLocation = []
  for (const loc of locations || []) {
    // Most-recent sync in THIS location's pack base. nullsFirst:false so
    // a contact that has actually synced sorts above never-synced ones.
    const { data: row, error } = await db
      .from('contacts')
      .select('glofox_synced_at')
      .eq('location_id', loc.id)
      .eq('glofox_membership_type', 'num_classes')
      .order('glofox_synced_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle()
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    }
    if (!row) continue // no pack base here — nothing to go stale

    const latestSync = row.glofox_synced_at || null
    const stale = isPackCreditDataStale(latestSync)
    perLocation.push({ location_id: loc.id, location: loc.name, latest_pack_sync: latestSync, healthy: !stale })

    if (stale) {
      logWarn('glofox-data-quality',
        `pack-credit data is stale at ${loc.name} — latest num_classes sync ${latestSync || 'never'} (threshold ${PACK_CREDIT_MAX_AGE_DAYS}d)`)
      // SAAS4-O2 — tell the tenant, not just the global heartbeat. Once
      // per daily run while stale; emails the org's ops recipients,
      // master-push fallback when none are configured.
      await sendOpsAlert({
        organizationId: loc.organization_id,
        locationId: loc.id,
        subject: `Glofox sync is stale at ${loc.name}`,
        htmlBody: `<p>The Glofox pack-credit data at <strong>${loc.name}</strong> has not synced since ${latestSync || 'never'} (threshold ${PACK_CREDIT_MAX_AGE_DAYS} days). Class-pack balances and the churn radar's Active base are drifting until the sync recovers.</p>`,
        pushBody: `Glofox pack-credit data at ${loc.name} last synced ${latestSync || 'never'} — the nightly sync looks broken.`,
      })
    } else {
      await stampTenantHeartbeat('glofox-data-quality', loc.id)
    }
  }

  // Global heartbeat semantics preserved: stamped only when EVERY
  // evaluated location is fresh (and at least one was evaluated —
  // an empty pack base everywhere reads as stale, exactly like the
  // old global query returning no row). The cron-health endpoint
  // flagging 'glofox-data-quality' as stale IS the alert.
  const healthy = perLocation.length > 0 && perLocation.every((l) => l.healthy)
  if (healthy) await stampHeartbeat('glofox-data-quality').catch(() => {})

  return NextResponse.json({ success: true, healthy, locations: perLocation })
}
