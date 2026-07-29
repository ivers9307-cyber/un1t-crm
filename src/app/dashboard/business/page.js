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
import { fetchFunnelCounts, fetchAdsSummary, fetchTodayOps } from '@shared/dashboard-data'
import { buildNeedsYouRail } from '@/lib/dashboard/business-rail'
import { buildBusinessKpis } from '@/lib/dashboard/business-kpis'
import { computeMembershipCounts } from '@/lib/membership-snapshot'
import { fetchMembershipFlows } from '@/lib/membership-flows'
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
  // DASH-M.1 — the awaits + shaping moved verbatim to
  // src/lib/dashboard/business-kpis.js so /api/dashboard/business (the
  // mobile Business dashboard's data route) computes the SAME numbers.
  // Returns null on failure (its internal try/catch), per the header.
  const vm = await buildBusinessKpis(db, user, locationId)
  if (!vm) return <BlockError label="Headline numbers" />

  const { revenue, arrearsData, memberCount, churnCount, churnDelta, briefing } = vm
  return (
    <>
      <BriefingLine text={briefing} />
      <KpiRow>
        <KpiCard label="Revenue MTD" value={formatCurrency(revenue.totalCents / 100)}
          sublabel={revenue.deltaPct != null ? `${revenue.deltaPct >= 0 ? '+' : ''}${Math.round(revenue.deltaPct)}% vs last month` : `${revenue.paidCount} payments`} />
        <KpiCard label="Members" value={memberCount ?? '—'}
          sublabel={memberCount != null ? 'active recurring' : 'membership unavailable'} href="/contacts" />
        <KpiCard label="Churn risk" value={churnCount ?? '—'}
          sublabel={churnCount == null ? 'radar unavailable' : (churnDelta > 0 ? `+${churnDelta} this week` : 'high-risk members')}
          accent={churnCount ? 'text-amber-700' : undefined} href="/dashboard/churn-radar" />
        <KpiCard label="In arrears" value={arrearsData ? formatCurrency(arrearsData.totalCents / 100) : '—'}
          sublabel={arrearsData ? `${arrearsData.memberCount} member${arrearsData.memberCount === 1 ? '' : 's'}` : 'arrears unavailable'}
          accent={arrearsData?.memberCount > 0 ? 'text-red-700' : undefined} href="/dashboard/churn-radar" />
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
    const [live, flows] = await Promise.all([
      computeMembershipCounts(db, locationId),
      fetchMembershipFlows(db, locationId, 12),
    ])
    // Falsy counts are a failure too — fall through to the error cell
    // rather than rendering nothing (JSX built after the try per the
    // error-boundaries lint rule; see the file header).
    if (live) data = { live, flows }
  } catch {
    data = null
  }
  if (!data) return <BlockError label="Membership sales" />
  return <MembershipPanel live={data.live} flows={data.flows} />
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
