// RCOV.P0/P2 — CoverageBoard: the /accounting Coverage tab. Client
// component so it can poll the coverage endpoint on filter change and
// drive the manual "Refresh from Xero" pull. P2 added the per-row
// operator actions (ignore / un-ignore / re-hunt / upload / copy a
// supplier-request message) — ignore and upload clear the line's hunt
// flags server-side so a queued line can never wedge the weekly
// finalizer. The force flag stays API-only (documented escape hatch,
// not a UI control).
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
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
  { value: '',                label: 'Open items' },
  { value: 'uncovered',       label: 'Needs receipt' },
  { value: 'submitted',       label: 'In review' },
  { value: 'needs_attention', label: 'Needs attention' },
  { value: 'covered',         label: 'Covered' },
  { value: 'ignored',         label: 'Ignored' },
  { value: 'all',             label: 'All' },
]

// RCOV.P2 — statuses that accept the operator actions.
const ACTIONABLE = new Set(['uncovered', 'not_found', 'needs_attention'])

const eur = (n) =>
  new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(Number(n) || 0)

const actionBtn = 'text-xs px-2 py-1 rounded bg-gray-500/10 text-gray-700 hover:bg-gray-500/20'

function requestTemplate(line) {
  return (
    `Hi — could you send me the invoice/receipt for the payment of ` +
    `${eur(Math.abs(Number(line.amount)))} on ${line.line_date}` +
    `${line.description ? ` (bank reference: ${line.description})` : ''}? ` +
    `It's needed for our VAT records. Thanks!`
  )
}

function RowActions({ line, onError, onDone }) {
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const fileRef = useRef(null)

  const post = async (path, opts = {}) => {
    setBusy(true)
    try {
      const res = await fetch(`/api/accounting/coverage/${line.id}/${path}`, { method: 'POST', ...opts })
      const json = await res.json().catch(() => ({}))
      if (!json.success) onError(json.error || `${path} failed`)
      else await onDone()
    } finally {
      setBusy(false)
    }
  }

  const ignore = () => {
    const reason = window.prompt('Why should this line be ignored? (e.g. bank fee, internal transfer)')
    if (!reason || reason.trim().length < 2) return
    post('ignore', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: reason.trim().slice(0, 200) }),
    })
  }

  const uploadPicked = (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const form = new FormData()
    form.append('file', file)
    post('upload', { body: form })
  }

  const copyRequest = async () => {
    try {
      await navigator.clipboard.writeText(requestTemplate(line))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      onError('Could not access the clipboard — copy manually from the supplier-request text.')
    }
  }

  if (line.status === 'ignored') {
    return (
      <button type="button" disabled={busy} className={actionBtn} onClick={() => post('unignore')}>
        Un-ignore
      </button>
    )
  }
  if (!ACTIONABLE.has(line.status)) return null

  return (
    <div className="flex flex-wrap gap-1">
      <button type="button" disabled={busy} className={actionBtn} onClick={() => fileRef.current?.click()}>
        Upload
      </button>
      <input ref={fileRef} type="file" accept=".pdf,image/*" className="hidden" onChange={uploadPicked} />
      <button type="button" disabled={busy} className={actionBtn} onClick={() => post('rehunt')}>
        Re-hunt
      </button>
      <button type="button" disabled={busy} className={actionBtn} onClick={copyRequest}>
        {copied ? 'Copied ✓' : 'Copy request'}
      </button>
      <button type="button" disabled={busy} className={actionBtn} onClick={ignore}>
        Ignore
      </button>
    </div>
  )
}

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

  const reload = useCallback(() => load(statusFilter), [load, statusFilter])

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
        <div className="flex flex-wrap gap-1">
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
            {
              key: 'actions',
              header: '',
              render: (r) => <RowActions line={r} onError={setError} onDone={reload} />,
            },
          ]}
        />
      )}
    </div>
  )
}
