'use client'
// InBodyProgress.jsx — CONSULTATIONS SP1
//
// Body-composition progress from InBody (LookInBody) scans. Shows a
// headline of the latest scan plus lazy line charts of weight / body-fat
// / muscle over time. No data fetching — `scans` comes from the page.
//
// Props:
//   scans — Array<inbody_scans row> with weight_kg / pbf_percent /
//           smm_kg / inbody_score / scanned_at
//
// recharts is heavy (~150KB), so the chart block is split into its own
// chunk via next/dynamic (ssr:false) — same pattern as
// MembershipFlowsChart — so it only ships when a contact actually has
// scans to plot.

import dynamic from 'next/dynamic'
import { Card } from '@/components/ui'
import InBodySyncButton from './InBodySyncButton'
import { latestScan, scanSeries } from '@/lib/consultations-view'

const InBodyCharts = dynamic(() => import('./InBodyCharts'), {
  ssr: false,
  loading: () => <p className="text-sm text-un1t-muted">Loading charts…</p>,
})

function Stat({ label, value, unit }) {
  if (value == null) return null
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-3">
      <p className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">{label}</p>
      <p className="text-xl font-bold mt-1 text-un1t-text">
        {value}
        {unit && <span className="text-sm font-normal text-un1t-subtle"> {unit}</span>}
      </p>
    </div>
  )
}

export default function InBodyProgress({ scans = [], contactId }) {
  if (!scans || scans.length === 0) {
    return (
      <Card title="InBody">
        <p className="text-sm text-un1t-muted">
          No InBody scans yet. If this member has been scanned on the machine, pull their history now.
        </p>
        {contactId && <InBodySyncButton contactId={contactId} />}
      </Card>
    )
  }

  const latest = latestScan(scans)
  const scannedOn = latest?.scanned_at
    ? new Date(latest.scanned_at).toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' })
    : null

  return (
    <Card title="InBody">
      {scannedOn && <p className="text-xs text-un1t-muted mb-3">Latest scan · {scannedOn}</p>}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <Stat label="Weight" value={latest?.weight_kg} unit="kg" />
        <Stat label="Body fat" value={latest?.pbf_percent} unit="%" />
        <Stat label="Muscle" value={latest?.smm_kg} unit="kg" />
        <Stat label="InBody score" value={latest?.inbody_score} />
      </div>

      <InBodyCharts
        series={[
          { key: 'weight_kg', label: 'Weight (kg)', color: '#10b981', data: scanSeries(scans, 'weight_kg') },
          { key: 'pbf_percent', label: 'Body fat (%)', color: '#f59e0b', data: scanSeries(scans, 'pbf_percent') },
          { key: 'smm_kg', label: 'Muscle (kg)', color: '#3b82f6', data: scanSeries(scans, 'smm_kg') },
        ]}
      />

      {contactId && <InBodySyncButton contactId={contactId} />}
    </Card>
  )
}
