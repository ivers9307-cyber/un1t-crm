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
// Auth, the error boundary and the global stamp: defineCron. A failed read
// answers 500 with a fixed line (detail in the log) and stamps nothing global.

import { defineCron } from '@/lib/define-cron'
import { stampTenantHeartbeat } from '@/lib/tenant-heartbeat'
import { listLocationsByMembershipSource } from '@/lib/membership/source'
import { sendOpsAlert } from '@/lib/ops-alerts'
import { logError, logWarn } from '@/lib/log'
import { isPackCreditDataStale, PACK_CREDIT_MAX_AGE_DAYS } from '@/lib/glofox-data-quality'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export const GET = defineCron({ heartbeat: 'glofox-data-quality' }, async ({ db }) => {
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
    logError('glofox-data-quality', 'failed to list active locations', { err: locErr })
    return { ok: false, body: { error: 'Could not read locations' } }
  }

  // W1.M3b — a location with NO membership source has no Glofox-shaped data
  // to read: skipped with a counted skipped_no_source. A failed seam read is a
  // 500 with no heartbeat, never "nobody to skip".
  // UN1TRADAR.3 — Glofox-source locations only: this checks GLOFOX pack-sync
  // freshness, which means nothing at a source that gains the memberships
  // capability (un1t.online). Every other active location is a counted skip.
  const { ids: glofoxIds, error: srcErr } = await listLocationsByMembershipSource(db, 'glofox')
  if (srcErr) {
    logError('glofox-data-quality', 'failed to read membership sources', { err: srcErr })
    return { ok: false, body: { error: 'Could not read membership sources' } }
  }
  const glofoxSet = new Set(glofoxIds || [])
  const noSource = { has: (id) => !glofoxSet.has(id) }
  let skippedNoSource = 0

  const perLocation = []
  for (const loc of locations || []) {
    if (noSource.has(loc.id)) { skippedNoSource++; continue }
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
      logError('glofox-data-quality', 'pack-sync read failed', { locationId: loc.id, err: error })
      return { ok: false, body: { error: 'Could not read pack-sync freshness' } }
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
  // flagging 'glofox-data-quality' as stale IS the alert. An unhealthy run
  // still answers success (stamp: false withholds the row only).
  const healthy = perLocation.length > 0 && perLocation.every((l) => l.healthy)
  return { body: { healthy, locations: perLocation, skipped_no_source: skippedNoSource }, stamp: healthy }
})
