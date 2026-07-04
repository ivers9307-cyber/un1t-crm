// RCOV.P0 — CoverageBoard: the /accounting page body. Client component
// so it can poll the coverage endpoint on filter change and drive the
// manual "Refresh from Xero" pull. Consumes only the two existing
// routes (GET /api/accounting/coverage, POST .../refresh) — no new API
// surface, no force flag (that's the documented escape hatch for a
// deliberate bulk-reconcile, not a P0 UI control), no row actions
// (deferred to Phase 2).
'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button, Card, Table, EmptyState, Loading } from '@/components/ui'

// Chip recipes are ALWAYS `bg-<c>-500/10 text-<c>-700` — anything else
// trips the `no-low-contrast-chip` guardrail (check:guardrails).
const STATUS_CHIP = {
  uncovered:       { label: 'Needs receipt',   cls: 'bg-amber-500/10 text-amber-700' },
  submitted:       { label: 'In review',       cls: 'bg-blue-500/10 text-blue-700' },
  not_found:       { label: 'Not found',       cls: 'bg-red-500/10 text-red-700' },
  needs_attention: { label: 'Needs attention', cls: 'bg-red-500/10 text-red-700' },
  covered:         { label: 'Covered',         cls: 'bg-green-500/10 text-green-700' },
  ignored:         { label: 'Ignored',         cls: 'bg-gray-500/10 text-gray-700' },
}

const FILTERS = [
  { value: '',          label: 'Open items' },
  { value: 'uncovered', label: 'Needs receipt' },
  { value: 'submitted', label: 'In review' },
  { value: 'covered',   label: 'Covered' },
  { value: 'all',       label: 'All' },
]

const eur = (n) =>
  new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(Number(n) || 0)

export default function CoverageBoard({ locationName }) {
  const [data, setData] = useState(null)
  const [statusFilter, setStatusFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async (filter) => {
    setError(null)
    const qs = filter ? `?status=${filter}` : ''
    const res = await fetch(`/api/accounting/coverage${qs}`)
    const json = await res.json()
    if (!json.success) { setError(json.error); return }
    setData(json.data)
  }, [])

  useEffect(() => { load(statusFilter) }, [load, statusFilter])

  const refresh = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/accounting/coverage/refresh', { method: 'POST' })
      const json = await res.json()
      if (!json.success) setError(json.error)
      await load(statusFilter)
    } finally {
      setBusy(false)
    }
  }

  if (!data && !error) return <Loading />

  const counts = data?.counts || {}
  const openCount = (counts.uncovered || 0) + (counts.submitted || 0) + (counts.not_found || 0) + (counts.needs_attention || 0)
  const total = openCount + (counts.covered || 0) + (counts.ignored || 0)
  const coveragePct = total > 0 ? Math.round(((counts.covered || 0) + (counts.ignored || 0)) / total * 100) : 100

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <div className="text-2xl font-semibold text-un1t-text">{coveragePct}%</div>
          <div className="text-xs text-un1t-subtle">Coverage ({locationName})</div>
        </Card>
        <Card>
          <div className="text-2xl font-semibold text-un1t-text">{counts.uncovered || 0}</div>
          <div className="text-xs text-un1t-subtle">Need a receipt</div>
        </Card>
        <Card>
          <div className="text-2xl font-semibold text-un1t-text">{counts.submitted || 0}</div>
          <div className="text-xs text-un1t-subtle">In review</div>
        </Card>
        <Card>
          <div className="text-2xl font-semibold text-un1t-text">
            {data?.lastRun ? new Date(data.lastRun.started_at).toLocaleDateString('en-IE') : '—'}
          </div>
          <div className="text-xs text-un1t-subtle">Last pull ({data?.lastRun?.trigger || 'never'})</div>
        </Card>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setStatusFilter(f.value)}
              className={`text-xs px-3 py-1.5 rounded ${statusFilter === f.value ? 'bg-un1t-text text-un1t-bg' : 'bg-gray-500/10 text-gray-700'}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <Button onClick={refresh} loading={busy}>
          {busy ? 'Pulling from Xero…' : 'Refresh from Xero'}
        </Button>
      </div>

      {error ? <div className="text-sm px-3 py-2 rounded bg-red-500/10 text-red-700">{error}</div> : null}

      {(data?.lines || []).length === 0 ? (
        <EmptyState title="Nothing here" description="No bank lines match this filter. Run a refresh to pull the latest from Xero." />
      ) : (
        <Table
          rows={data.lines}
          columns={[
            {
              key: 'line_date',
              header: 'Date',
              render: (r) => <span className="text-sm text-un1t-text">{r.line_date}</span>,
            },
            {
              key: 'description',
              header: 'Description',
              render: (r) => (
                <div className="text-sm">
                  <div className="font-medium text-un1t-text">{r.description || '(no description)'}</div>
                  <div className="text-xs text-un1t-subtle">{r.reference}</div>
                </div>
              ),
            },
            {
              key: 'amount',
              header: 'Amount',
              render: (r) => (
                <span className={`text-sm ${Number(r.amount) < 0 ? 'text-un1t-text' : 'text-green-700'}`}>
                  {eur(r.amount)}
                </span>
              ),
            },
            {
              key: 'bank_account_name',
              header: 'Account',
              render: (r) => <span className="text-xs text-un1t-subtle">{r.bank_account_name}</span>,
            },
            {
              key: 'status',
              header: 'Status',
              render: (r) => {
                const chip = STATUS_CHIP[r.status] || STATUS_CHIP.uncovered
                return <span className={`text-xs px-2 py-1 rounded ${chip.cls}`}>{chip.label}</span>
              },
            },
          ]}
        />
      )}
    </div>
  )
}
