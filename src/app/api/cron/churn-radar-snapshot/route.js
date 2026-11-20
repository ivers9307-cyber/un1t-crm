// RADAR-TREND.1 — weekly churn-radar snapshot cron.
//
// Runs Monday 06:00 UTC. For every active location it computes the
// current churn radar summary and writes one churn_radar_snapshots
// row. The radar UI then compares the live summary against the most
// recent snapshot to show week-over-week deltas on the summary cards.
//
// defineCron owns the CRON_SECRET check, the error boundary and the stamp.
// A failed locations read, membership-source read or snapshot insert answers
// 500 with a fixed error (the detail is logged) and no stamp. One location's
// radar failing is a fixed per-location error and the run still stamps.

import { defineCron } from '@/lib/define-cron'
import { loadRadar } from '@/lib/churn-radar-data'
import { locationIdsWithoutCapability } from '@/lib/membership/locations-for-source'
import { logError, logWarn } from '@/lib/log'

const MODULE = 'cron-churn-radar-snapshot'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// loadRadar pages the member base + action log per location. Single-
// tenant in practice; 120s leaves headroom if more locations are added.
export const maxDuration = 120

export const GET = defineCron({ heartbeat: 'churn-radar-snapshot' }, async ({ db }) => {
  const { data: locations, error: locErr } = await db
    .from('locations')
    .select('id, name')
    .eq('active', true)
  if (locErr) {
    logError(MODULE, 'failed to list locations', { err: locErr.message })
    return { ok: false, body: { error: 'Could not list locations' } }
  }

  // W1.M3b — a location with NO membership source has no Glofox-shaped data
  // to read: skipped with a counted skipped_no_source. A failed seam read is a
  // 500 with no heartbeat, never "nobody to skip".
  const { ids: noSource, error: srcErr } = await locationIdsWithoutCapability(db, 'memberships') // UN1TCAP.1: a configured source can lack memberships (none; un1t.online provides them since UN1TRADAR.4)
  if (srcErr) {
    logError(MODULE, 'failed to read membership sources', { err: srcErr?.message ?? srcErr })
    return { ok: false, body: { error: 'Could not read membership sources' } }
  }
  let skippedNoSource = 0

  const rows = []
  const perLocation = []
  for (const loc of locations || []) {
    if (noSource.has(loc.id)) { skippedNoSource++; continue }
    try {
      const { summary } = await loadRadar(db, loc.id)
      rows.push({
        location_id: loc.id,
        active_base: summary.activeBase || 0,
        at_risk: summary.atRisk || 0,
        high_risk: summary.highRisk || 0,
        overdue: summary.overdue || 0,
        paused: summary.paused || 0,
        quarantine: summary.quarantine || 0,
        revenue_at_risk_cents: summary.revenueAtRiskCents || 0,
        overdue_value_cents: summary.overdueValueCents || 0,
      })
      perLocation.push({ location_id: loc.id, location_name: loc.name, ok: true })
    } catch (e) {
      // One bad location can't stall the rest of the sweep. A fixed line in
      // the response; the detail is logged.
      logWarn(MODULE, 'radar failed for location', { locationId: loc.id, err: e?.message })
      perLocation.push({ location_id: loc.id, location_name: loc.name, ok: false, error: 'radar failed' })
    }
  }

  let snapshotsWritten = 0
  if (rows.length) {
    const { error: insErr } = await db.from('churn_radar_snapshots').insert(rows)
    if (insErr) {
      logError(MODULE, 'snapshot insert failed', { err: insErr.message, rows: rows.length })
      return { ok: false, body: { error: 'Could not write the snapshots' } }
    }
    snapshotsWritten = rows.length
  }

  return {
    body: {
      locations: perLocation.length,
      skipped_no_source: skippedNoSource,
      snapshots_written: snapshotsWritten,
      perLocation,
    },
  }
})
