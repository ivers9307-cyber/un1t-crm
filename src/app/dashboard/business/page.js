// /dashboard/business — DASH-REBUILD command centre. Each block is an
// async server component in its own Suspense boundary: the shell paints
// immediately, blocks stream as their live queries settle, and one
// failing block renders a compact error cell instead of blanking the
// page (the old all-or-nothing fetch is gone). All-live by design
// (Richard, 2026-07-04) — streaming is the perf counterweight.
import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import {
  fetchRevenueMTD, fetchArrearsSummary, fetchFunnelCounts, fetchAdsSummary, fetchTodayOps,
} from '@shared/dashboard-data'
import { buildBusinessBriefing } from '@shared/business-briefing'
import { buildNeedsYouRail } from '@/lib/dashboard/business-rail'
import { getPendingApprovalsCount } from '@/lib/approvals/registry'
import { computeMembershipCounts, fetchMembershipTrend } from '@/lib/membership-snapshot'
import { loadRadar } from '@/lib/churn-radar-data'
import { KpiCard, KpiRow, formatCurrency } from '@/components/dashboard/Cards'
import { MembershipPanel } from '@/components/dashboard/MembershipPanel'
import {
  BriefingLine, FunnelMini, AdsSummaryPanel, TodayStrip, NeedsYouRail, BlockSkeleton, BlockError,
} from '@/components/dashboard/BusinessBlocks'

export const dynamic = 'force-dynamic'

// eslint react-hooks/error-boundaries forbids constructing JSX inside a
// try/catch (rendering errors escape the try). So every block does its
// awaits + shaping inside try/catch and returns a plain data object (or
// null on failure); the JSX is built after the try, outside its scope.
async function KpiBriefingBlock({ user, locationId }) {
  const db = createServerClient()
  let vm = null
  try {
    // DASH-REBUILD.6b — derive the briefing's attention labels locally
    // from data this block already holds (approvals count + arrears +
    // churn). The full rail is built once, in RailBlock — calling
    // buildNeedsYouRail here too would double the 8-provider approvals
    // fan-out + leads/failed queries every page load.
    const [revenue, arrears, membershipLive, radar, approvalsCount] = await Promise.all([
      fetchRevenueMTD(db, locationId),
      fetchArrearsSummary(db, locationId),
      // Guarded like radar/approvals — any of its internal count
      // queries throwing must not reject the whole Promise.all and
      // discard four healthy data points.
      computeMembershipCounts(db, locationId).catch(() => null),
      loadRadar(db, locationId).catch(() => null),
      getPendingApprovalsCount(db, user).catch(() => 0),
    ])
    if (!revenue.success) throw new Error(revenue.error)
    const arrearsData = arrears.success ? arrears.data : { totalCents: 0, memberCount: 0 }
    // null (not 0) when membership failed — the card shows '—', not a
    // fake zero; the briefing's own `|| 0` handles its degradation.
    const memberCount = membershipLive
      ? (membershipLive.active_recurring ?? membershipLive.monthly_recurring ?? 0)
      : null
    const churnCount = radar?.summary?.highRisk ?? null

    // Priority order, non-zero only, max 3. Rail text uses compact euro
    // strings; the KPI cards below use formatCurrency — intentionally
    // different registers, not a bug.
    const labels = []
    if (approvalsCount > 0) labels.push(`${approvalsCount} pending approval${approvalsCount === 1 ? '' : 's'}`)
    if (arrearsData.memberCount > 0) labels.push(`${arrearsData.memberCount} in arrears (€${Math.round(arrearsData.totalCents / 100).toLocaleString('en-IE')})`)
    if (churnCount > 0) labels.push(`${churnCount} at churn risk`)

    const briefing = buildBusinessBriefing({
      revenue: { totalCents: revenue.data.totalCents, deltaPct: revenue.data.deltaPct },
      members: { count: memberCount, netChange: null },
      attention: labels.slice(0, 3).map(l => ({ label: l })),
    })
    vm = { revenue: revenue.data, arrearsData, memberCount, churnCount, briefing }
  } catch {
    vm = null
  }
  if (!vm) return <BlockError label="Headline numbers" />

  const { revenue, arrearsData, memberCount, churnCount, briefing } = vm
  return (
    <>
      <BriefingLine text={briefing} />
      <KpiRow>
        <KpiCard label="Revenue MTD" value={formatCurrency(revenue.totalCents / 100)}
          sublabel={revenue.deltaPct != null ? `${revenue.deltaPct >= 0 ? '+' : ''}${Math.round(revenue.deltaPct)}% vs last month` : `${revenue.paidCount} payments`} />
        <KpiCard label="Members" value={memberCount ?? '—'}
          sublabel={memberCount != null ? 'active recurring' : 'membership unavailable'} href="/contacts" />
        <KpiCard label="Churn risk" value={churnCount ?? '—'}
          sublabel={churnCount != null ? 'high-risk members' : 'radar unavailable'}
          accent={churnCount ? 'text-amber-700' : undefined} href="/dashboard/churn-radar" />
        <KpiCard label="In arrears" value={formatCurrency(arrearsData.totalCents / 100)}
          sublabel={`${arrearsData.memberCount} member${arrearsData.memberCount === 1 ? '' : 's'}`}
          accent={arrearsData.memberCount > 0 ? 'text-red-700' : undefined} href="/dashboard/churn-radar" />
      </KpiRow>
    </>
  )
}

async function FunnelAdsBlock({ locationId }) {
  const db = createServerClient()
  let data = null
  try {
    const [funnel, ads] = await Promise.all([
      fetchFunnelCounts(db, locationId),
      fetchAdsSummary(db, locationId),
    ])
    data = { funnel, ads }
  } catch {
    data = null
  }
  if (!data) return <BlockError label="Funnel and ads" />

  const { funnel, ads } = data
  // AdsSummaryPanel / TodayStrip figures render full-digit (list
  // register); the KPI cards above abbreviate via formatCurrency
  // (headline register). Deliberate divergence — do not unify.
  return (
    <div className="grid sm:grid-cols-2 gap-3">
      <div className="bg-un1t-surface border border-un1t-border rounded-lg px-4 py-3">
        <p className="text-xs text-un1t-muted mb-2">Acquisition funnel · this month</p>
        {funnel.success ? <FunnelMini funnel={funnel.data} /> : <BlockError label="Funnel" />}
      </div>
      <div className="bg-un1t-surface border border-un1t-border rounded-lg px-4 py-3">
        <p className="text-xs text-un1t-muted mb-2">Ads · last 7 days</p>
        {ads.success ? <AdsSummaryPanel ads={ads.data} /> : <BlockError label="Ads" />}
      </div>
    </div>
  )
}

async function MembershipBlock({ locationId }) {
  const db = createServerClient()
  let data = null
  try {
    const [live, trend] = await Promise.all([
      computeMembershipCounts(db, locationId),
      fetchMembershipTrend(db, locationId, 12),
    ])
    if (!live) return null
    data = { live, trend }
  } catch {
    return <BlockError label="Membership trend" />
  }
  return <MembershipPanel live={data.live} trend={data.trend} />
}

async function TodayBlock({ locationId, locationName }) {
  const db = createServerClient()
  let ops = null
  try {
    const res = await fetchTodayOps(db, locationId)
    if (!res.success) throw new Error(res.error)
    ops = res.data
  } catch {
    ops = null
  }
  if (!ops) return <BlockError label="Today's operations" />
  return <TodayStrip ops={ops} locationName={locationName} />
}

async function RailBlock({ user, locationId }) {
  const db = createServerClient()
  let rows = null
  try {
    rows = await buildNeedsYouRail(db, user, locationId)
  } catch {
    return <BlockError label="Needs you" />
  }
  return <NeedsYouRail rows={rows} />
}

export default async function BusinessDashboardPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'dashboard_business')) redirect('/dashboard')
  const locationId = user.activeLocation?.id
  const locationName = user.activeLocation?.name

  return (
    <>
      <Suspense fallback={<BlockSkeleton lines={4} />}>
        <KpiBriefingBlock user={user} locationId={locationId} />
      </Suspense>
      <div className="grid xl:grid-cols-3 gap-4 mt-4">
        <div className="xl:col-span-2 space-y-4">
          <Suspense fallback={<BlockSkeleton lines={4} />}>
            <FunnelAdsBlock locationId={locationId} />
          </Suspense>
          <Suspense fallback={<BlockSkeleton lines={5} />}>
            <MembershipBlock locationId={locationId} />
          </Suspense>
          <Suspense fallback={<BlockSkeleton lines={2} />}>
            <TodayBlock locationId={locationId} locationName={locationName} />
          </Suspense>
        </div>
        <div className="xl:order-none order-first">
          <Suspense fallback={<BlockSkeleton lines={6} />}>
            <RailBlock user={user} locationId={locationId} />
          </Suspense>
        </div>
      </div>
    </>
  )
}
