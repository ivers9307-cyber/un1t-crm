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
      <div className="flex flex-wrap gap-2 border-b border-un1t-gray pb-2">
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
                  ? 'bg-un1t-white text-un1t-black border-un1t-white'
                  : 'border-transparent text-un1t-light hover:text-un1t-white hover:bg-un1t-gray/30'
              }`}
            >
              {t.label}
              <span className={`ml-2 text-xs ${active ? 'text-un1t-black/60' : 'text-un1t-mid'}`}>
                {count}
              </span>
            </button>
          )
        })}
        <button
          type="button"
          onClick={load}
          className="ml-auto text-xs text-un1t-light hover:text-un1t-white inline-flex items-center gap-1"
          title="Refresh"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {/* Filter row */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-un1t-light" />
          <input
            type="text"
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1) }}
            placeholder="Email or name…"
            className="pl-7 pr-3 py-1.5 text-sm bg-un1t-black border border-un1t-gray rounded-md text-un1t-white w-56"
          />
        </div>
        <select
          value={sourceType}
          onChange={(e) => { setSourceType(e.target.value); setPage(1) }}
          className="text-sm bg-un1t-black border border-un1t-gray rounded-md px-2 py-1.5 text-un1t-white"
        >
          <option value="">All sources</option>
          <option value="race_registration">Race signups</option>
          <option value="car_deposit">Car deposits</option>
        </select>
        <input
          type="date"
          value={from}
          onChange={(e) => { setFrom(e.target.value); setPage(1) }}
          className="text-sm bg-un1t-black border border-un1t-gray rounded-md px-2 py-1.5 text-un1t-white"
          title="From"
        />
        <input
          type="date"
          value={to}
          onChange={(e) => { setTo(e.target.value); setPage(1) }}
          className="text-sm bg-un1t-black border border-un1t-gray rounded-md px-2 py-1.5 text-un1t-white"
          title="To"
        />
        {(sourceType || from || to || q) && (
          <button
            type="button"
            onClick={() => { setSourceType(''); setFrom(''); setTo(''); setQ(''); setPage(1) }}
            className="text-xs text-un1t-light hover:text-un1t-white inline-flex items-center gap-1"
          >
            <X size={12} /> Clear
          </button>
        )}
      </div>

      {/* Rows */}
      {loading && !data && (
        <div className="text-sm text-un1t-light inline-flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" /> Loading orders…
        </div>
      )}

      {data && rows.length === 0 && (
        <div className="text-sm text-un1t-light italic px-2 py-8 text-center">
          No orders match the current filters.
        </div>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto border border-un1t-gray rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider text-un1t-light bg-un1t-gray/20">
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
                <OrderRow key={row.id} row={row} onRefunded={load} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-un1t-light">
          <div>{total} order{total === 1 ? '' : 's'}</div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage(p => Math.max(1, p - 1))}
              className="px-2 py-1 border border-un1t-gray rounded-md disabled:opacity-30"
            >Prev</button>
            <span>{page} / {totalPages}</span>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              className="px-2 py-1 border border-un1t-gray rounded-md disabled:opacity-30"
            >Next</button>
          </div>
        </div>
      )}
    </div>
  )
}

function OrderRow({ row, onRefunded }) {
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

  function navigateToDetail(e) {
    // Don't navigate when the operator's interacting with the
    // refund control or its confirm/cancel buttons.
    if (confirming) return
    if (e.target.closest('button')) return
    router.push(`/orders/${row.id}`)
  }

  async function handleRefund() {
    setBusy(true)
    setRefundError(null)
    try {
      const r = await fetch(`/api/orders/${row.id}/refund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setRefundError(j.error || `Refund failed (${r.status})`)
        setBusy(false)
        return
      }
      setConfirming(false)
      setBusy(false)
      onRefunded?.()
    } catch (e) {
      setRefundError(e.message || 'Network error')
      setBusy(false)
    }
  }

  return (
    <tr
      className="border-t border-un1t-gray hover:bg-un1t-gray/10 cursor-pointer"
      onClick={navigateToDetail}
    >
      <td className="px-3 py-2 text-un1t-light whitespace-nowrap">{dateLabel}</td>
      <td className="px-3 py-2">
        <div className="text-un1t-white">{row.contact_name || row.contact_email}</div>
        {row.contact_name && (
          <div className="text-[11px] text-un1t-light">{row.contact_email}</div>
        )}
      </td>
      <td className="px-3 py-2">
        <div className="text-un1t-white">{sourceLabel}</div>
        {sourceDetail && <div className="text-[11px] text-un1t-light">{sourceDetail}</div>}
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
            className="text-[11px] text-un1t-light hover:text-purple-700 inline-flex items-center gap-1"
            title="Issue a full refund via Revolut"
          >
            <Undo2 size={11} /> Refund
          </button>
        )}
        {canRefund && confirming && (
          <div className="inline-flex items-center gap-1.5">
            <span className="text-[11px] text-un1t-light">Refund {amount}?</span>
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
              className="text-[11px] text-un1t-light hover:text-un1t-white"
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
      </td>
    </tr>
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
  }
  return (
    <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full ${map[status] || 'bg-un1t-gray/30 text-un1t-light'}`}>
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
