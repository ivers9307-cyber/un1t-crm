// RCOV — Payables tab: aged accounts payable (who we owe, how overdue).
// Live pull from Xero on mount + manual refresh. Read-only view.
'use client'

import { useCallback, useEffect, useState } from 'react'
import { Card, Table, EmptyState, Loading, Button } from '@/components/ui'

const eur = (n) =>
  new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(Number(n) || 0)

const BUCKET_COLS = [
  { key: 'not_due', label: 'Not due' },
  { key: 'd1_30', label: '1–30d' },
  { key: 'd31_60', label: '31–60d' },
  { key: 'd61_90', label: '61–90d' },
  { key: 'd90_plus', label: '90d+' },
]

// Oldest-overdue chip — the "how overdue" at a glance.
function overdueChip(days) {
  if (days === null || days <= 0) return <span className="text-xs px-2 py-1 rounded bg-gray-500/10 text-gray-700">Not due</span>
  const cls =
    days > 90 ? 'bg-red-500/10 text-red-700'
      : days > 30 ? 'bg-orange-500/10 text-orange-700'
        : 'bg-amber-500/10 text-amber-700'
  return <span className={`text-xs px-2 py-1 rounded ${cls}`}>{days}d overdue</span>
}

export default function PayablesPanel() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    const res = await fetch('/api/accounting/payables')
    const json = await res.json().catch(() => ({}))
    if (!json.success) { setError(json.error || 'Failed to load payables'); return }
    setData(json.data)
  }, [])

  useEffect(() => { load() }, [load])

  const refresh = async () => {
    setBusy(true)
    await load()
    setBusy(false)
  }

  if (!data && !error) return <Loading />

  const t = data?.totals || {}

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <div className="text-2xl font-semibold text-un1t-text">{eur(t.total)}</div>
          <div className="text-xs text-un1t-subtle">Total owed</div>
        </Card>
        <Card>
          <div className="text-2xl font-semibold text-red-700">{eur(t.overdue)}</div>
          <div className="text-xs text-un1t-subtle">Overdue</div>
        </Card>
        <Card>
          <div className="text-2xl font-semibold text-un1t-text">{eur(t.d90_plus)}</div>
          <div className="text-xs text-un1t-subtle">90d+ overdue</div>
        </Card>
        <Card>
          <div className="text-2xl font-semibold text-un1t-text">{data?.supplierCount ?? 0}</div>
          <div className="text-xs text-un1t-subtle">Suppliers · {t.billCount ?? 0} bills</div>
        </Card>
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-un1t-subtle">
          Unpaid supplier bills in Xero for this location, as at {data?.asOf || '—'}. Most overdue first.
        </p>
        <Button onClick={refresh} loading={busy}>{busy ? 'Refreshing…' : 'Refresh'}</Button>
      </div>

      {error ? <div className="text-sm px-3 py-2 rounded bg-red-500/10 text-red-700">{error}</div> : null}

      {(data?.suppliers || []).length === 0 ? (
        <EmptyState title="Nothing owed" description="No unpaid supplier bills in Xero for this location." />
      ) : (
        <Table
          rows={data.suppliers}
          rowKey={(r) => r.contactId || r.contactName}
          columns={[
            {
              key: 'contactName',
              header: 'Supplier',
              render: (r) => (
                <div className="text-sm">
                  <div className="font-medium text-un1t-text">{r.contactName}</div>
                  <div className="mt-0.5">{overdueChip(r.oldestDays)}</div>
                </div>
              ),
            },
            ...BUCKET_COLS.map((c) => ({
              key: c.key,
              header: c.label,
              render: (r) => (
                <span className={`text-sm ${c.key !== 'not_due' && r.buckets[c.key] > 0 ? 'text-un1t-text' : 'text-un1t-subtle'}`}>
                  {r.buckets[c.key] > 0 ? eur(r.buckets[c.key]) : '—'}
                </span>
              ),
            })),
            {
              key: 'total',
              header: 'Owed',
              render: (r) => <span className="text-sm font-semibold text-un1t-text">{eur(r.total)}</span>,
            },
          ]}
        />
      )}
    </div>
  )
}
