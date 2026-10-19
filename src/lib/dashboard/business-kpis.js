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

import { arrearsBriefingLabel } from '@/lib/radar-copy'
import { buildBusinessBriefing } from '@shared/business-briefing'
import { getPendingApprovalsCount } from '@/lib/approvals/registry'
import { membershipReadsFor, supportsRead } from '@/lib/membership/reads'
import { providesCapability } from '@/lib/membership/state-for-page'
import { loadRadar } from '@/lib/churn-radar-data'
import { displayZoneFor } from '@/lib/display-zone'

// UN1TREAD.3 — the numbers come through the membership read seam, not from
// the Glofox functions directly. A Glofox studio's adapter forwards the same
// arguments to the same functions, so its view-model is deep-equal to before;
// un1t.online supplies revenue + member counts and no arrears; the radar-derived
// cells (Churn risk) stay behind providesCapability(membership, 'memberships'),
// because the radars read Glofox tables.
//
// A source that is not `configured` has no reads at all (membershipReadsFor
// gives reads: null). The surface then draws its MembershipSourceGate, which
// still wants the briefing line (approvals are source-independent), so that
// case returns a numberless view-model (revenue keeps the pre-change ZERO
// shape, never null: pre-M3c phones read kpis.revenue.totalCents unguarded)
// with an approvals-only briefing and runs no membership read. A CONFIGURED
// source that lacks revenueMtd is a whole-block failure (null), as a failed
// revenue read always was.
//
// `gate: { state, showNumbers }` is computed from the SAME membershipReadsFor
// result the numbers came from, so a surface decides "numbers or gate" from the
// view-model itself, not from a second (possibly diverging) state read.
export async function buildBusinessKpis(db, user, locationId, nowMs = Date.now()) {
  try {
    const m = await membershipReadsFor(db, locationId)
    if (!m.reads) {
      const approvals = await getPendingApprovalsCount(db, user).catch(() => 0)
      const briefing = approvals > 0
        ? `Watch: ${approvals} pending approval${approvals === 1 ? '' : 's'}.`
        : 'Nothing urgent.'
      return {
        revenue: { totalCents: 0, paidCount: 0, deltaPct: null },
        arrearsData: null, memberCount: null, churnCount: null, churnDelta: null, briefing,
        gate: { state: m.state, showNumbers: false },
      }
    }
    if (!supportsRead(m, 'revenueMtd')) return null
    // UN1TREAD.7 — from the reads result's own state + capabilities, not a second state read.
    const radarOk = providesCapability(m, 'memberships')
    // DASH-REBUILD.6b — derive the briefing's attention labels locally
    // from data this block already holds (approvals count + arrears +
    // churn). The full rail is built once, in the rail block — calling
    // buildNeedsYouRail here too would double the 8-provider approvals
    // fan-out + leads/failed queries every load.
    // Comparator snapshot for the churn week-over-week delta: the most
    // recent snapshot at least ~a week old. Guarded so any failure
    // yields null (quiet) rather than rejecting the whole fan-out.
    const sixDaysAgoIso = new Date(nowMs - 6 * 24 * 60 * 60 * 1000).toISOString()
    const churnSnapshot = !radarOk ? Promise.resolve(null) : db.from('churn_radar_snapshots')
      .select('high_risk, captured_at')
      .eq('location_id', locationId)
      .lte('captured_at', sixDaysAgoIso)
      .order('captured_at', { ascending: false }).limit(1)
      .then(({ data }) => data?.[0] ?? null, () => null)
    // TZ.11a — Revenue MTD is the studio's calendar month.
    const zone = await displayZoneFor(db, user, locationId, 'business-kpis')
    const [revenue, arrears, membershipLive, radar, approvalsCount, churnPrev] = await Promise.all([
      m.reads.revenueMtd(db, locationId, new Date(nowMs), zone),
      // un1t reads arrears from spec A's past-due rows since UN1TRADAR.2; a source with no arrears read is null, not a Glofox zero.
      supportsRead(m, 'arrears') ? m.reads.arrears(db, locationId) : Promise.resolve(null),
      // Guarded like radar/approvals — any of its internal count
      // queries throwing must not reject the whole Promise.all and
      // discard four healthy data points.
      (supportsRead(m, 'membershipCounts') ? m.reads.membershipCounts(db, locationId) : Promise.resolve(null)).catch(() => null),
      radarOk ? loadRadar(db, locationId).catch(() => null) : Promise.resolve(null),
      getPendingApprovalsCount(db, user).catch(() => 0),
      churnSnapshot,
    ])
    if (!revenue.success) throw new Error(revenue.error)
    // null (not a fake {0,0}) when arrears failed — the card shows '—',
    // not a dishonest "€0 · 0 members" (DASH-REBUILD.6c pattern).
    const arrearsData = arrears?.success ? arrears.data : null
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
    if (arrearsData?.memberCount > 0) labels.push(arrearsBriefingLabel(arrearsData))
    if (churnCount > 0) labels.push(`${churnCount} at churn risk`)

    const briefing = buildBusinessBriefing({
      revenue: { totalCents: revenue.data.totalCents, deltaPct: revenue.data.deltaPct },
      members: { count: memberCount, netChange: null },
      attention: labels.slice(0, 3).map(l => ({ label: l })),
    })
    const showNumbers = supportsRead(m, 'membershipCounts') && supportsRead(m, 'revenueMtd')
    return { revenue: revenue.data, arrearsData, memberCount, churnCount, churnDelta, briefing, gate: { state: m.state, showNumbers } }
  } catch {
    return null
  }
}
