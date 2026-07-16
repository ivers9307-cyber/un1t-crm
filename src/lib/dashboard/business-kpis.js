// src/lib/dashboard/business-kpis.js
//
// DASH-M.1 — the Business dashboard's headline-KPI + briefing
// composition, extracted verbatim from the KpiBriefingBlock server
// component in src/app/dashboard/business/page.js so the web page and
// the mobile JSON route (/api/dashboard/business) consume the SAME
// computation — no duplicated KPI logic. Web-only imports (approvals
// registry + radar) keep this in src/lib, not shared/.
//
// Returns the block view-model or null on failure (the callers render
// a compact error cell on null — the web page's DASH-REBUILD error
// posture, mirrored by the route as a null block key).

import { fetchRevenueMTD, fetchArrearsSummary } from '@shared/dashboard-data'
import { buildBusinessBriefing } from '@shared/business-briefing'
import { getPendingApprovalsCount } from '@/lib/approvals/registry'
import { computeMembershipCounts } from '@/lib/membership-snapshot'
import { loadRadar } from '@/lib/churn-radar-data'

export async function buildBusinessKpis(db, user, locationId, nowMs = Date.now()) {
  try {
    // DASH-REBUILD.6b — derive the briefing's attention labels locally
    // from data this block already holds (approvals count + arrears +
    // churn). The full rail is built once, in the rail block — calling
    // buildNeedsYouRail here too would double the 8-provider approvals
    // fan-out + leads/failed queries every load.
    // Comparator snapshot for the churn week-over-week delta: the most
    // recent snapshot at least ~a week old. Guarded so any failure
    // yields null (quiet) rather than rejecting the whole fan-out.
    const sixDaysAgoIso = new Date(nowMs - 6 * 24 * 60 * 60 * 1000).toISOString()
    const churnSnapshot = db.from('churn_radar_snapshots')
      .select('high_risk, captured_at')
      .eq('location_id', locationId)
      .lte('captured_at', sixDaysAgoIso)
      .order('captured_at', { ascending: false }).limit(1)
      .then(({ data }) => data?.[0] ?? null, () => null)
    const [revenue, arrears, membershipLive, radar, approvalsCount, churnPrev] = await Promise.all([
      fetchRevenueMTD(db, locationId),
      fetchArrearsSummary(db, locationId),
      // Guarded like radar/approvals — any of its internal count
      // queries throwing must not reject the whole Promise.all and
      // discard four healthy data points.
      computeMembershipCounts(db, locationId).catch(() => null),
      loadRadar(db, locationId).catch(() => null),
      getPendingApprovalsCount(db, user).catch(() => 0),
      churnSnapshot,
    ])
    if (!revenue.success) throw new Error(revenue.error)
    // null (not a fake {0,0}) when arrears failed — the card shows '—',
    // not a dishonest "€0 · 0 members" (DASH-REBUILD.6c pattern).
    const arrearsData = arrears.success ? arrears.data : null
    // null (not 0) when membership failed — the card shows '—', not a
    // fake zero; the briefing's own `|| 0` handles its degradation.
    const memberCount = membershipLive
      ? (membershipLive.active_recurring ?? membershipLive.monthly_recurring ?? 0)
      : null
    const churnCount = radar?.summary?.highRisk ?? null
    // Week-over-week churn delta vs the comparator snapshot. Only shown
    // when both sides are known and the trend is up (quiet otherwise).
    const snapshotHigh = churnPrev?.high_risk ?? null
    const churnDelta = (churnCount != null && snapshotHigh != null) ? churnCount - snapshotHigh : null

    // Priority order, non-zero only, max 3. Rail text uses compact euro
    // strings; the KPI cards use formatCurrency — intentionally
    // different registers, not a bug.
    const labels = []
    if (approvalsCount > 0) labels.push(`${approvalsCount} pending approval${approvalsCount === 1 ? '' : 's'}`)
    if (arrearsData?.memberCount > 0) labels.push(`${arrearsData.memberCount} in arrears (€${Math.round(arrearsData.totalCents / 100).toLocaleString('en-IE')})`)
    if (churnCount > 0) labels.push(`${churnCount} at churn risk`)

    const briefing = buildBusinessBriefing({
      revenue: { totalCents: revenue.data.totalCents, deltaPct: revenue.data.deltaPct },
      members: { count: memberCount, netChange: null },
      attention: labels.slice(0, 3).map(l => ({ label: l })),
    })
    return { revenue: revenue.data, arrearsData, memberCount, churnCount, churnDelta, briefing }
  } catch {
    return null
  }
}
