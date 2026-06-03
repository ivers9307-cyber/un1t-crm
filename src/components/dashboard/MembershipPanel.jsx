'use client'

// MembershipPanel — DASH-MEMBERSHIP.2.
//
// Business-board membership section: live breakdown KPI cards (read
// from contacts on each load, always current) + a 12-month trend chart
// (read from membership_snapshots, grows one point per month).
//
// Receives already-fetched data from the server page so it stays a thin
// presentation component. Recharts is the charting lib (DASH-MEMBERSHIP
// recommendation — scales to the further board panels).

import dynamic from 'next/dynamic'
import { KpiCard, KpiRow, SectionHeader } from './Cards'

// Lazy-load the recharts trend chart so the ~150KB charting lib is only
// fetched when the trend section renders, not on every dashboard load.
// ssr:false — the chart is client-only and below the KPI cards anyway.
const MembershipTrendChart = dynamic(() => import('./MembershipTrendChart'), {
  ssr: false,
  loading: () => (
    <div style={{ height: 280 }} className="flex items-center justify-center">
      <p className="text-sm text-un1t-muted">Loading chart…</p>
    </div>
  ),
})

export function MembershipPanel({ live, trend }) {
  const l = live || {}
  const hasTrend = Array.isArray(trend) && trend.length > 0

  return (
    <>
      <SectionHeader title="Membership" />

      <KpiRow>
        <KpiCard
          label="Monthly recurring"
          value={l.monthly_recurring ?? 0}
          sublabel={`${l.active_recurring ?? 0} active subscriptions`}
          accent="text-green-500"
        />
        <KpiCard
          label="Class packs"
          value={l.class_packs ?? 0}
          sublabel={`${l.dead_packs ?? 0} with no credits left`}
          accent={(l.dead_packs ?? 0) > 0 ? 'text-amber-500' : 'text-un1t-text'}
        />
      </KpiRow>
      <KpiRow>
        <KpiCard
          label="Pay-as-you-go"
          value={l.payg ?? 0}
          sublabel="drop-in credit buyers"
        />
        <KpiCard
          label="Total members"
          value={l.total_members ?? 0}
          sublabel="all Glofox member records"
        />
      </KpiRow>

      <SectionHeader title="Membership trend (12 months)" />
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
        {hasTrend ? (
          <MembershipTrendChart trend={trend} />
        ) : (
          <p className="text-sm text-un1t-muted py-8 text-center">
            Trend starts building from the first monthly snapshot. Check back next month
            for the first data point.
          </p>
        )}
      </div>
    </>
  )
}
