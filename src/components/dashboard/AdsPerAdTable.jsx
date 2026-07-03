// ADS-REPORT.3 — per-ad breakdown table for /dashboard/ads.
//
// Renders loadAdsDashboard()'s already-sorted `perAd` rows (cpa asc,
// null-cpa last) over the Table primitive (@/components/ui). Retired/
// paused ads (status !== 'ACTIVE') are greyed out with a muted text
// class rather than removed — an operator still wants to see what a
// killed ad's cost-per-booking was.

import { Table } from '@/components/ui'

function formatEuro(n) {
  if (n == null || Number.isNaN(n)) return '—'
  return `€${Number(n).toLocaleString('en-IE', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
}

function formatPercent(n) {
  if (n == null || Number.isNaN(n)) return '—'
  return `${n}%`
}

function rowTextClass(row) {
  return row.status && row.status !== 'ACTIVE' ? 'text-un1t-muted' : 'text-un1t-text'
}

const COLUMNS = [
  {
    key: 'name',
    header: 'Ad',
    render: (row) => <span className={rowTextClass(row)}>{row.name}</span>,
  },
  {
    key: 'spend',
    header: 'Spend',
    align: 'right',
    render: (row) => <span className={rowTextClass(row)}>{formatEuro(row.spend)}</span>,
  },
  {
    key: 'impressions',
    header: 'Impressions',
    align: 'right',
    render: (row) => <span className={rowTextClass(row)}>{Number(row.impressions || 0).toLocaleString('en-IE')}</span>,
  },
  {
    key: 'ctr',
    header: 'CTR',
    align: 'right',
    render: (row) => <span className={rowTextClass(row)}>{formatPercent(row.ctr)}</span>,
  },
  {
    key: 'link_clicks',
    header: 'Link clicks',
    align: 'right',
    render: (row) => <span className={rowTextClass(row)}>{Number(row.link_clicks || 0).toLocaleString('en-IE')}</span>,
  },
  {
    key: 'landing_page_views',
    header: 'Landing views',
    align: 'right',
    render: (row) => <span className={rowTextClass(row)}>{Number(row.landing_page_views || 0).toLocaleString('en-IE')}</span>,
  },
  {
    key: 'bookings',
    header: 'Bookings',
    align: 'right',
    render: (row) => <span className={rowTextClass(row)}>{row.bookings ?? 0}</span>,
  },
  {
    key: 'cpa',
    header: 'Cost / booking',
    align: 'right',
    // Hero column — bold regardless of active/retired so the metric
    // that matters most stays legible even on greyed-out rows.
    render: (row) => (
      <span className={`font-semibold ${rowTextClass(row)}`}>{formatEuro(row.cpa)}</span>
    ),
  },
]

export default function AdsPerAdTable({ rows }) {
  return (
    <Table
      columns={COLUMNS}
      rows={rows || []}
      rowKey={(row) => row.ad_id}
      empty="No per-ad data yet."
    />
  )
}
