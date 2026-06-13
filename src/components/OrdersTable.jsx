'use client'

// OrdersTable — operator-facing list of every order. Mig 085.
//
// Tabs across the top: Completed / Pending / Failed / Abandoned /
// Recovered / Refunded — counts per tab pulled in the same payload.
// Filters: source type, date range, free-text email/name search.
// Per-row: contact, source link (race name or car reg), amount,
// status, date, retry-chain pill if applicable.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, AlertCircle, Search, RefreshCw, X, Undo2, Check as CheckIcon } from 'lucide-react'

const STATUS_TABS = [
  { id: 'completed', label: 'Completed', accent: 'emerald' },
  { id: 'pending', label: 'Pending', accent: 'amber' },
  { id: 'failed', label: 'Failed', accent: 'red' },
  { id: 'abandoned', label: 'Abandoned', accent: 'gray' },
  { id: 'recovered', label: 'Recovered', accent: 'blue' },
  { id: 'refunded', label: 'Refunded', accent: 'purple' },
  { id: 'cancelled', label: 'Cancelled', accent: 'slate' },
]

const SOURCE_LABELS = {
  race_registration: 'Race signup',
  car_deposit: 'Car deposit',
}

export default function OrdersTable() {
  const [status, setStatus] = useState('completed')
  const [sourceType, setSourceType] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [q, setQ] = useState('')
  const [data, setData] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)

  async function load() {
    setLoading(true)
    setLoadError(null)
    const params = new URLSearchParams({ status, page: String(page), limit: '50' })
    if (sourceType) params.set('source_type', sourceType)
    if (from) params.set('from', from)
    if (to) params.set('to', to)
    if (q) params.set('q', q)
    try {
      const r = await fetch(`/api/orders?${params.toString()}`, { cache: 'no-store' })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setLoadError(j.error || `Fetch failed (${r.status})`)
      } else {
        setData(j)
      }
    } catch (e) {
      setLoadError(e.message || 'Network error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, sourceType, from, to, q, page])

  const counts = data?.counts || {}
  const rows = data?.data || []
  const total = data?.total || 0
  const totalPages = Math.max(1, Math.ceil(total / (data?.limit || 50)))

  return (
    <div className="space-y-4">
      {loadError && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-md p-3 inline-flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 shrink-0" /> {loadError}
        </div>
      )}

      {/* Status tabs with counts */}
      <div className="flex flex-wrap gap-2 border-b border-un1t-border pb-2">
        {STATUS_TABS.map((t) => {
          const active = status === t.id
          const count = counts[t.id] ?? 0
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => { setStatus(t.id); setPage(1) }}
              className={`text-sm px-3 py-1.5 rounded-md border transition-colors ${
                active
                  ? 'bg-un1t-text text-un1t-bg border-un1t-text'
                  : 'border-transparent text-un1t-subtle hover:text-un1t-text hover:bg-un1t-border/30'
              }`}
            >
              {t.label}
              <span className={`ml-2 text-xs ${active ? 'text-un1t-bg/60' : 'text-un1t-muted'}`}>
                {count}
              </span>
            </button>
          )
        })}
        <button
          type="button"
          onClick={load}
          className="ml-auto text-xs text-un1t-subtle hover:text-un1t-text inline-flex items-center gap-1"
          title="Refresh"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {/* Filter row */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-un1t-subtle" />
          <input
            type="text"
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1) }}
            placeholder="Email or name…"
            className="pl-7 pr-3 py-1.5 text-sm bg-un1t-bg border border-un1t-border rounded-md text-un1t-text w-56"
          />
        </div>
        <select
          value={sourceType}
          onChange={(e) => { setSourceType(e.target.value); setPage(1) }}
          className="text-sm bg-un1t-bg border border-un1t-border rounded-md px-2 py-1.5 text-un1t-text"
        >
          <option value="">All sources</option>
          <option value="race_registration">Race signups</option>
          <option value="car_deposit">Car deposits</option>
        </select>
        <input
          type="date"
          value={from}
          onChange={(e) => { setFrom(e.target.value); setPage(1) }}
          className="text-sm bg-un1t-bg border border-un1t-border rounded-md px-2 py-1.5 text-un1t-text"
          title="From"
        />
        <input
          type="date"
          value={to}
          onChange={(e) => { setTo(e.target.value); setPage(1) }}
          className="text-sm bg-un1t-bg border border-un1t-border rounded-md px-2 py-1.5 text-un1t-text"
          title="To"
        />
        {(sourceType || from || to || q) && (
          <button
            type="button"
            onClick={() => { setSourceType(''); setFrom(''); setTo(''); setQ(''); setPage(1) }}
            className="text-xs text-un1t-subtle hover:text-un1t-text inline-flex items-center gap-1"
          >
            <X size={12} /> Clear
          </button>
        )}
      </div>

      {/* Rows */}
      {loading && !data && (
        <div className="text-sm text-un1t-subtle inline-flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" /> Loading orders…
        </div>
      )}

      {data && rows.length === 0 && (
        <div className="text-sm text-un1t-subtle italic px-2 py-8 text-center">
          No orders match the current filters.
        </div>
      )}

      {rows.length > 0 && (
        <>
          {/* Desktop table — hidden below md so phones don't have to
              horizontal-scroll a 6-column grid with inline refund UI. */}
          <div className="hidden md:block overflow-x-auto border border-un1t-border rounded-lg">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wider text-un1t-subtle bg-un1t-border/20">
                  <th className="text-left px-3 py-2">Date</th>
                  <th className="text-left px-3 py-2">Contact</th>
                  <th className="text-left px-3 py-2">Source</th>
                  <th className="text-right px-3 py-2">Amount</th>
                  <th className="text-left px-3 py-2">Status</th>
                  <th className="text-right px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <OrderRow key={row.id} row={row} onChanged={load} />
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile card list — same data without the inline refund
              widget. Tapping a card navigates to /orders/[id] which
              has the full refund flow. md:hidden so it's invisible
              from tablet upwards. */}
          <div className="md:hidden space-y-2">
            {rows.map((row) => (
              <OrderCard key={row.id} row={row} />
            ))}
          </div>
        </>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-un1t-subtle">
          <div>{total} order{total === 1 ? '' : 's'}</div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage(p => Math.max(1, p - 1))}
              className="px-2 py-1 border border-un1t-border rounded-md disabled:opacity-30"
            >Prev</button>
            <span>{page} / {totalPages}</span>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              className="px-2 py-1 border border-un1t-border rounded-md disabled:opacity-30"
            >Next</button>
          </div>
        </div>
      )}
    </div>
  )
}

function OrderRow({ row, onChanged }) {
  const router = useRouter()
  const dt = row.created_at ? new Date(row.created_at) : null
  const dateLabel = dt ? dt.toLocaleString('en-IE', {
    timeZone: 'Europe/Dublin',
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }) : ''
  const amount = formatMoney(row.amount_cents, row.currency)
  const sourceLabel = SOURCE_LABELS[row.source_type] || row.source_type
  const meta = row.metadata || {}
  const sourceDetail = row.source_type === 'race_registration'
    ? '' // race name lookup would require extra join; future enhancement
    : [meta.car_make, meta.car_model, meta.irish_reg].filter(Boolean).join(' ')

  // Refund button is only meaningful on completed Revolut orders.
  const canRefund = row.status === 'completed' && row.payment_provider === 'revolut'
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refundError, setRefundError] = useState(null)
  // Partial-refund amount in major units (€). Defaults to the full
  // order amount; operator can override before confirming.
  const [refundEuros, setRefundEuros] = useState(() =>
    Number.isFinite(row.amount_cents) ? (row.amount_cents / 100).toFixed(2) : ''
  )

  // Cancel is the housekeeping counterpart — only meaningful on a
  // PENDING order (ORDERS-CANCEL.1). Clears the pending clutter.
  const canCancel = row.status === 'pending'
  const [cancelConfirming, setCancelConfirming] = useState(false)
  const [cancelBusy, setCancelBusy] = useState(false)
  const [cancelError, setCancelError] = useState(null)

  function navigateToDetail(e) {
    // Don't navigate when the operator's interacting with the
    // refund / cancel control or any input/button inside the row.
    if (confirming || cancelConfirming) return
    if (e.target.closest('button, input')) return
    router.push(`/orders/${row.id}`)
  }

  async function handleCancel() {
    setCancelBusy(true)
    setCancelError(null)
    try {
      const r = await fetch(`/api/orders/${row.id}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setCancelError(j.error || `Cancel failed (${r.status})`)
        setCancelBusy(false)
        return
      }
      setCancelConfirming(false)
      setCancelBusy(false)
      onChanged?.()
    } catch (e) {
      setCancelError(e.message || 'Network error')
      setCancelBusy(false)
    }
  }

  async function handleRefund() {
    // Validate partial-refund amount client-side. Server re-checks
    // and rejects with refund_exceeds_order if needed.
    const major = Number(refundEuros)
    if (!Number.isFinite(major) || major <= 0) {
      setRefundError('Enter a positive amount.')
      return
    }
    const cents = Math.round(major * 100)
    if (cents > row.amount_cents) {
      setRefundError(`Cannot refund more than the order total (${formatMoney(row.amount_cents, row.currency)}).`)
      return
    }
    const isFull = cents === row.amount_cents
    setBusy(true)
    setRefundError(null)
    try {
      const r = await fetch(`/api/orders/${row.id}/refund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Omit amount_cents on full refund — server treats missing
        // as "full" which is the safest semantic.
        body: JSON.stringify(isFull ? {} : { amount_cents: cents }),
      })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setRefundError(j.error || `Refund failed (${r.status})`)
        setBusy(false)
        return
      }
      setConfirming(false)
      setBusy(false)
      onChanged?.()
    } catch (e) {
      setRefundError(e.message || 'Network error')
      setBusy(false)
    }
  }

  return (
    <tr
      className="border-t border-un1t-border hover:bg-un1t-border/10 cursor-pointer"
      onClick={navigateToDetail}
    >
      <td className="px-3 py-2 text-un1t-subtle whitespace-nowrap">{dateLabel}</td>
      <td className="px-3 py-2">
        <div className="text-un1t-text">{row.contact_name || row.contact_email}</div>
        {row.contact_name && (
          <div className="text-[11px] text-un1t-subtle">{row.contact_email}</div>
        )}
      </td>
      <td className="px-3 py-2">
        <div className="text-un1t-text">{sourceLabel}</div>
        {sourceDetail && <div className="text-[11px] text-un1t-subtle">{sourceDetail}</div>}
        {row.retry_of_order_id && (
          <div className="text-[11px] text-blue-700 mt-0.5">
            ↻ Retry of an earlier failure
          </div>
        )}
      </td>
      <td className="px-3 py-2 text-right font-mono tabular-nums">{amount}</td>
      <td className="px-3 py-2">
        <StatusPill status={row.status} />
      </td>
      <td className="px-3 py-2 text-right whitespace-nowrap">
        {canRefund && !confirming && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="text-[11px] text-un1t-subtle hover:text-purple-700 inline-flex items-center gap-1"
            title="Issue a full refund via Revolut"
          >
            <Undo2 size={11} /> Refund
          </button>
        )}
        {canRefund && confirming && (
          <div className="inline-flex items-center gap-1.5">
            <span className="text-[11px] text-un1t-subtle">Refund €</span>
            <input
              type="number"
              min="0.01"
              step="0.01"
              max={row.amount_cents / 100}
              value={refundEuros}
              onChange={(e) => setRefundEuros(e.target.value)}
              className="text-[11px] bg-un1t-bg border border-un1t-border rounded px-1.5 py-0.5 text-un1t-text w-20 tabular-nums"
              title={`Up to ${amount} (full refund). Lower for partial.`}
            />
            <button
              type="button"
              onClick={handleRefund}
              disabled={busy}
              className="text-[11px] bg-purple-600 hover:bg-purple-700 text-white px-2 py-0.5 rounded inline-flex items-center gap-1 disabled:opacity-40"
            >
              {busy ? <Loader2 size={10} className="animate-spin" /> : <CheckIcon size={10} />}
              {busy ? 'Refunding…' : 'Confirm'}
            </button>
            <button
              type="button"
              onClick={() => { setConfirming(false); setRefundError(null) }}
              disabled={busy}
              className="text-[11px] text-un1t-subtle hover:text-un1t-text"
            >
              Cancel
            </button>
          </div>
        )}
        {refundError && (
          <div className="text-[11px] text-red-700 mt-1 max-w-[200px] truncate" title={refundError}>
            {refundError}
          </div>
        )}
        {canCancel && !cancelConfirming && (
          <button
            type="button"
            onClick={() => setCancelConfirming(true)}
            className="text-[11px] text-un1t-subtle hover:text-red-700 inline-flex items-center gap-1"
            title="Clear this pending order (e.g. a duplicate attempt)"
          >
            <X size={11} /> Cancel
          </button>
        )}
        {canCancel && cancelConfirming && (
          <div className="inline-flex items-center gap-1.5">
            <span className="text-[11px] text-un1t-subtle">Clear this pending order?</span>
            <button
              type="button"
              onClick={handleCancel}
              disabled={cancelBusy}
              className="text-[11px] bg-red-600 hover:bg-red-700 text-white px-2 py-0.5 rounded inline-flex items-center gap-1 disabled:opacity-40"
            >
              {cancelBusy ? <Loader2 size={10} className="animate-spin" /> : <CheckIcon size={10} />}
              {cancelBusy ? 'Cancelling…' : 'Confirm'}
            </button>
            <button
              type="button"
              onClick={() => { setCancelConfirming(false); setCancelError(null) }}
              disabled={cancelBusy}
              className="text-[11px] text-un1t-subtle hover:text-un1t-text"
            >
              Keep
            </button>
          </div>
        )}
        {cancelError && (
          <div className="text-[11px] text-red-700 mt-1 max-w-[200px] truncate" title={cancelError}>
            {cancelError}
          </div>
        )}
      </td>
    </tr>
  )
}

// Mobile-only — same data as OrderRow minus the inline refund UI
// (refund still works from /orders/[id], just one extra tap). Tap
// the card to navigate to the detail page. Kept as a sibling of
// OrderRow rather than a CSS-only restyle because the row's
// "tr / td" structure can't reflow into a stacked card without
// breaking the table semantics.
function OrderCard({ row }) {
  const router = useRouter()
  const dt = row.created_at ? new Date(row.created_at) : null
  const dateLabel = dt ? dt.toLocaleString('en-IE', {
    timeZone: 'Europe/Dublin',
    day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit',
  }) : ''
  const amount = formatMoney(row.amount_cents, row.currency)
  const sourceLabel = SOURCE_LABELS[row.source_type] || row.source_type
  const meta = row.metadata || {}
  const sourceDetail = row.source_type === 'race_registration'
    ? ''
    : [meta.car_make, meta.car_model, meta.irish_reg].filter(Boolean).join(' ')

  return (
    <button
      type="button"
      onClick={() => router.push(`/orders/${row.id}`)}
      className="w-full text-left bg-un1t-surface border border-un1t-border rounded-lg p-3 active:bg-un1t-border/30 transition-colors"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-un1t-text truncate">
            {row.contact_name || row.contact_email || 'Unknown'}
          </div>
          {row.contact_name && row.contact_email && (
            <div className="text-[11px] text-un1t-subtle truncate">{row.contact_email}</div>
          )}
        </div>
        <div className="text-right shrink-0">
          <div className="font-mono tabular-nums text-un1t-text">{amount}</div>
          <div className="text-[10px] text-un1t-subtle">{dateLabel}</div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 mt-2">
        <div className="text-[11px] text-un1t-subtle truncate">
          {sourceLabel}
          {sourceDetail && <span className="text-un1t-muted"> · {sourceDetail}</span>}
          {row.retry_of_order_id && (
            <span className="text-blue-700"> · ↻ Retry</span>
          )}
        </div>
        <StatusPill status={row.status} />
      </div>
    </button>
  )
}

function StatusPill({ status }) {
  const map = {
    completed: 'bg-emerald-500/15 text-emerald-700',
    pending: 'bg-amber-500/15 text-amber-700',
    failed: 'bg-red-500/15 text-red-700',
    abandoned: 'bg-gray-500/15 text-gray-600',
    recovered: 'bg-blue-500/15 text-blue-700',
    refunded: 'bg-purple-500/15 text-purple-700',
    cancelled: 'bg-slate-500/15 text-slate-600',
  }
  return (
    <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full ${map[status] || 'bg-un1t-border/30 text-un1t-subtle'}`}>
      {status}
    </span>
  )
}

function formatMoney(cents, currency) {
  if (!Number.isFinite(cents)) return ''
  const major = (cents / 100).toFixed(2)
  if (currency === 'EUR') return `€${major}`
  if (currency === 'GBP') return `£${major}`
  return `${major} ${currency || ''}`.trim()
}
