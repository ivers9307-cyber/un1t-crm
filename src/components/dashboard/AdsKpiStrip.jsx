// ADS-REPORT.3 — top-of-page KPI strip for /dashboard/ads.
//
// Five cards over the Card primitive (@/components/ui). Cost / booked
// class is the hero metric — the number an operator actually cares
// about ("is this ad spend worth it") — so it gets emphasis (larger,
// bolder) the other four don't. Presentational only — no directive
// needed (RSC-compatible), matches Card/EmptyState's pattern.

import { Card } from '@/components/ui'

function formatEuro(n) {
  if (n == null || Number.isNaN(n)) return '—'
  return `€${Number(n).toLocaleString('en-IE', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
}

function formatPercent(n) {
  if (n == null || Number.isNaN(n)) return '—'
  return `${n}%`
}

export default function AdsKpiStrip({ kpis }) {
  const { spend, bookings, cpa, ctr, active_ads: activeAds } = kpis || {}

  return (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
      <Card padding="md">
        <div className="text-xs uppercase tracking-wider text-un1t-subtle">Spend (30d)</div>
        <div className="text-2xl font-bold mt-1 text-un1t-text">{formatEuro(spend)}</div>
      </Card>

      {/* Hero card — cost per booked class is the metric that decides
          whether the spend is working. Larger value + accent colour
          distinguishes it from the other four. */}
      <Card padding="md" className="border-un1t-accent/40 bg-blue-500/10">
        <div className="text-xs uppercase tracking-wider text-blue-700">Cost / booked class</div>
        <div className="text-3xl font-bold mt-1 text-blue-700">{formatEuro(cpa)}</div>
      </Card>

      <Card padding="md">
        <div className="text-xs uppercase tracking-wider text-un1t-subtle">Bookings</div>
        <div className="text-2xl font-bold mt-1 text-un1t-text">{bookings ?? 0}</div>
      </Card>

      <Card padding="md">
        <div className="text-xs uppercase tracking-wider text-un1t-subtle">Blended CTR</div>
        <div className="text-2xl font-bold mt-1 text-un1t-text">{formatPercent(ctr)}</div>
      </Card>

      <Card padding="md">
        <div className="text-xs uppercase tracking-wider text-un1t-subtle">Active ads</div>
        <div className="text-2xl font-bold mt-1 text-un1t-text">{activeAds ?? 0}</div>
      </Card>
    </div>
  )
}
