'use client'

// ADS-REPORT.3 — client-side lazy-load wrapper for AdsTrendChart.
//
// next/dynamic's `ssr: false` option is only valid inside a Client
// Component (Next.js 16 App Router rejects it in a Server Component —
// see /dashboard/ads/page.js, which stays a server component). Mirrors
// how MembershipPanel.jsx (a 'use client' component) wraps
// MembershipTrendChart with dynamic(..., { ssr: false }) rather than
// the server page doing it directly.

import dynamic from 'next/dynamic'

const AdsTrendChart = dynamic(() => import('./AdsTrendChart'), {
  ssr: false,
  loading: () => (
    <div style={{ height: 280 }} className="flex items-center justify-center">
      <p className="text-sm text-un1t-muted">Loading chart…</p>
    </div>
  ),
})

export default function AdsTrendChartLazy({ data }) {
  return <AdsTrendChart data={data} />
}
