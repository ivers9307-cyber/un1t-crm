// SAAS4-O1 — per-tenant cron heartbeats (SaaS machinery plan §4).
//
// cron_heartbeats is name-keyed: one green row can mask one tenant's
// rotting sync behind another tenant's healthy one. tenant_heartbeats
// (mig 412) adds the (name, location_id) dimension ADDITIVELY — the
// global table, the cron_health view, and the external sentinel
// contract are untouched. Only loop-over-locations crons stamp it.
//
// Rows are created lazily on first stamp (no per-location seeding in
// provisioning), inheriting the parent cron's cadence so the tenant
// view flags staleness on the same clock. Best-effort like
// stampHeartbeat: a metering/monitoring write must never fail the cron.

import { createServerClient } from '@/lib/supabase'
import { logWarn } from '@/lib/log'

/**
 * Stamp last_ok_at = NOW() for one (cron, location) pair.
 * Never throws; never blocks the cron.
 *
 * @param {string} name - cron name (matches cron_heartbeats.name)
 * @param {string} locationId - the tenant location this tick covered
 * @param {{ db?: object }} [deps] - injectable for tests
 */
export async function stampTenantHeartbeat(name, locationId, { db } = {}) {
  if (!name || typeof name !== 'string' || !locationId) return

  try {
    const client = db || createServerClient()

    // Inherit the parent cron's cadence (null when unregistered — the
    // tenant_cron_health view treats a null interval as never-stale).
    const { data: parent } = await client
      .from('cron_heartbeats')
      .select('expected_interval_seconds, grace_seconds')
      .eq('name', name)
      .maybeSingle()

    const { error } = await client.from('tenant_heartbeats').upsert(
      {
        name,
        location_id: locationId,
        last_ok_at: new Date().toISOString(),
        expected_interval_seconds: parent?.expected_interval_seconds ?? null,
        grace_seconds: parent?.grace_seconds ?? null,
        // NOTE: no `muted` here — that's operator state; a stamp must
        // never overwrite it.
      },
      { onConflict: 'name,location_id' }
    )
    if (error) logWarn('tenant-heartbeat', 'stamp failed', { name, locationId, err: error })
  } catch (e) {
    logWarn('tenant-heartbeat', 'stamp threw', { name, locationId, err: e })
  }
}
