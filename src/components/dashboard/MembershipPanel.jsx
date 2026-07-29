'use client'

// MembershipPanel — DASH-MEMBERSHIP.2 (chart reworked in TREND-FLOWS.1).
//
// Business-board membership section: live breakdown KPI cards (read
// from contacts on each load, always current) + a weekly
// sales-vs-cancellations bar chart (sales from subscription-start
// invoices, cancellations from the membership_transitions trigger log
// — see src/lib/membership-flows.js for the definitions and data
// epochs).
//
// Receives already-fetched data from the server page so it stays a thin
// presentation component.

import dynamic from 'next/dynamic'
import { KpiCard, KpiRow, SectionHeader } from './Cards'

// Lazy-load the recharts chart so the ~150KB charting lib is only
// fetched when the section renders, not on every dashboard load.
// ssr:false — the chart is client-only and below the KPI cards anyway.
const MembershipFlowsChart = dynamic(() => import('./MembershipFlowsChart'), {
  ssr: false,
  loading: () => (
    <div style={{ height: 280 }} className="flex items-center justify-center">
      <p className="text-sm text-un1t-muted">Loading chart…</p>
    </div>
  ),
})

// 'YYYY-MM-DD' → '29 Jul 2026' for the tracking-start footnote.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function dateLabel(d) {
  if (typeof d !== 'string' || d.length < 10) return d
  return `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`
}

export function MembershipPanel({ live, flows }) {
  const l = live || {}
  const weeks = flows?.weeks
  const hasFlows = Array.isArray(weeks) && weeks.length > 0
  // Footnote only while the chart still contains untracked weeks —
  // once every rendered week postdates the trigger it disappears.
  const hasUntrackedWeeks = hasFlows && weeks.some((w) => w.cancellations == null)

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

      <SectionHeader title="Membership sales vs cancellations (weekly)" />
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
        {hasFlows ? (
          <>
            <MembershipFlowsChart weeks={weeks} />
            {hasUntrackedWeeks ? (
              <p className="text-xs text-un1t-muted mt-2">
                Cancellation tracking started {dateLabel(flows.cancelTrackingStart)} — earlier
                weeks show sales only.
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-un1t-muted py-8 text-center">
            No membership sales or cancellations recorded yet.
          </p>
        )}
      </div>
    </>
  )
}
