// /dashboard/business — Business dashboard. Owner-level. Same data
// as the mobile BusinessDashboard.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { fetchBusinessDashboardData } from '@shared/dashboard-data'
import {
  KpiCard, KpiRow, SectionHeader, formatCurrency, formatPercent,
} from '@/components/dashboard/Cards'
import { MembershipPanel } from '@/components/dashboard/MembershipPanel'
import { computeMembershipCounts, fetchMembershipTrend } from '@/lib/membership-snapshot'

export const dynamic = 'force-dynamic'

export default async function BusinessDashboardPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'dashboard_business')) redirect('/dashboard')

  const db = createServerClient()
  const res = await fetchBusinessDashboardData(db, user.activeLocation?.id)
  if (!res.success) {
    return <p className="text-sm text-red-500">Failed to load dashboard: {res.error}</p>
  }
  const {
    openPipelineValue, openDealCount,
    wonValueMTD, wonCountMTD, lostCountMTD, winRatePercent,
    scheduledHoursThisWeek, scheduledLabourThisWeek,
  } = res.data

  // DASH-MEMBERSHIP.2 — membership breakdown (live from contacts) +
  // 12-month trend (from membership_snapshots). Best-effort: a failure
  // here must not blank the whole board, so default to empties.
  const locId = user.activeLocation?.id
  let membershipLive = null
  let membershipTrend = []
  if (locId) {
    try {
      ;[membershipLive, membershipTrend] = await Promise.all([
        computeMembershipCounts(db, locId),
        fetchMembershipTrend(db, locId, 12),
      ])
    } catch {
      membershipLive = null
      membershipTrend = []
    }
  }

  return (
    <>
      <SectionHeader title="Pipeline" />
      <KpiRow>
        <KpiCard
          label="Open value"
          value={formatCurrency(openPipelineValue)}
          sublabel={`${openDealCount} open deal${openDealCount === 1 ? '' : 's'}`}
          href="/pipeline"
        />
        <KpiCard
          label="Won this month"
          value={formatCurrency(wonValueMTD)}
          sublabel={`${wonCountMTD} deal${wonCountMTD === 1 ? '' : 's'}`}
          accent="text-green-500"
        />
      </KpiRow>
      <KpiRow>
        <KpiCard
          label="Lost this month"
          value={lostCountMTD}
          sublabel={lostCountMTD === 1 ? 'deal' : 'deals'}
          accent={lostCountMTD > 0 ? 'text-red-500' : 'text-un1t-muted'}
        />
        <KpiCard
          label="Win rate"
          value={formatPercent(winRatePercent)}
          sublabel={
            winRatePercent == null
              ? 'no decided deals yet'
              : `${wonCountMTD} won / ${lostCountMTD} lost`
          }
        />
      </KpiRow>

      {membershipLive && <MembershipPanel live={membershipLive} trend={membershipTrend} />}

      <SectionHeader title="Scheduled labour" />
      <KpiRow>
        <KpiCard
          label="Hours this week"
          value={`${scheduledHoursThisWeek}h`}
          sublabel={`at ${user.activeLocation?.name || 'this location'}`}
        />
        <KpiCard
          label="Labour cost (est.)"
          value={formatCurrency(scheduledLabourThisWeek)}
          sublabel="excludes overtime premium"
        />
      </KpiRow>
      <p className="text-xs text-un1t-muted mt-1 px-1">
        Labour cost is a base estimate from each staffer&apos;s contract / hourly rate.
        The full payroll report (including overtime, NI, etc.) lives under{' '}
        <a href="/schedule" className="underline">Schedule</a>.
      </p>
    </>
  )
}
