'use client'

// ORDERSVIEW.1 — the owner view above the Orders list: what was taken, by
// kind and studio, what went back, and the latest refunds (a refund Revolut
// declined after it was recorded is flagged). Reads GET /api/orders/summary.
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Loader2, AlertCircle, AlertTriangle } from 'lucide-react'
import { SOURCE_LABELS, formatMoney } from './OrdersTable'

const PERIODS = [
  { id: '30', label: 'Last 30 days', days: 30 },
  { id: '365', label: 'Last 12 months', days: 365 },
  { id: 'all', label: 'All time', days: null },
]

export default function OrdersSummary() {
  const [period, setPeriod] = useState('30')
  const [state, setState] = useState({ loading: true, data: null, error: null })

  useEffect(() => {
    let live = true
    const days = PERIODS.find((p) => p.id === period)?.days
    const params = new URLSearchParams()
    if (days) params.set('from', new Date(Date.now() - days * 86_400_000).toISOString())
    setState((s) => ({ ...s, loading: true, error: null }))
    fetch(`/api/orders/summary?${params}`)
      .then(async (r) => {
        const j = await r.json()
        if (!live) return
        if (!r.ok || j.success === false) setState({ loading: false, data: null, error: j.error || `Could not load totals (${r.status})` })
        else setState({ loading: false, data: j.data, error: null })
      })
      .catch((e) => live && setState({ loading: false, data: null, error: e.message || 'Network error' }))
    return () => { live = false }
  }, [period])

  const { loading, data, error } = state
  const studioName = new Map((data?.studios || []).map((s) => [s.id, s.name]))
  const manyStudios = new Set((data?.totals || []).map((t) => t.location_id)).size > 1
  const totals = data?.totals || []
  const byCurrency = totals.reduce((acc, t) => {
    const c = (acc[t.currency] ||= { gross: 0, refunded: 0, net: 0, orders: 0 })
    c.gross += t.gross_cents; c.refunded += t.refunded_cents; c.net += t.net_cents; c.orders += t.orders
    return acc
  }, {})

  return (
    <section className="mb-6 space-y-4" aria-label="Order totals">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-sm font-semibold text-un1t-text">Totals</h2>
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          aria-label="Period"
          className="text-sm bg-un1t-bg border border-un1t-border rounded-md px-2 py-1.5 text-un1t-text"
        >
          {PERIODS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </div>

      {loading && <div className="text-sm text-un1t-subtle inline-flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading totals…</div>}
      {error && <div role="alert" className="text-sm text-red-700 inline-flex items-center gap-2"><AlertCircle size={14} /> {error}</div>}

      {!loading && !error && data && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {Object.entries(byCurrency).map(([cur, c]) => (
              <div key={cur} className="contents">
                <Stat label="Taken" value={formatMoney(c.gross, cur)} sub={`${c.orders} order${c.orders === 1 ? '' : 's'}`} />
                <Stat label="Refunded" value={formatMoney(c.refunded, cur)} />
                <Stat label="Kept" value={formatMoney(c.net, cur)} />
              </div>
            ))}
            {totals.length === 0 && <p className="text-sm text-un1t-subtle sm:col-span-3">No paid orders in this period.</p>}
          </div>

          {totals.length > 0 && (
            <div className="bg-un1t-surface border border-un1t-border rounded-lg overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-[11px] uppercase tracking-wider text-un1t-subtle">
                  <tr>
                    {manyStudios && <th className="text-left px-3 py-2">Studio</th>}
                    <th className="text-left px-3 py-2">Kind</th>
                    <th className="text-right px-3 py-2">Orders</th>
                    <th className="text-right px-3 py-2">Taken</th>
                    <th className="text-right px-3 py-2">Refunded</th>
                    <th className="text-right px-3 py-2">Kept</th>
                  </tr>
                </thead>
                <tbody>
                  {totals.map((t) => (
                    <tr key={`${t.location_id}|${t.source_type}|${t.currency}`} className="border-t border-un1t-border">
                      {manyStudios && <td className="px-3 py-2 text-un1t-text">{studioName.get(t.location_id) || 'Unknown studio'}</td>}
                      <td className="px-3 py-2 text-un1t-text">{SOURCE_LABELS[t.source_type] || t.source_type}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{t.orders}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">{formatMoney(t.gross_cents, t.currency)}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">{formatMoney(t.refunded_cents, t.currency)}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">{formatMoney(t.net_cents, t.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data.truncated && <p className="text-[11px] text-amber-700">Showing the latest 20,000 orders only; pick a shorter period for exact totals.</p>}

          <div>
            <h3 className="text-sm font-semibold text-un1t-text mb-2">Recent refunds</h3>
            {data.refunds.length === 0 ? (
              <p className="text-sm text-un1t-subtle">No refunds in this period.</p>
            ) : (
              <ul className="bg-un1t-surface border border-un1t-border rounded-lg divide-y divide-un1t-border text-sm">
                {data.refunds.map((r) => (
                  <li key={r.id} className="px-3 py-2 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link href={`/orders/${r.order_id}`} className="text-un1t-text hover:underline">
                        {r.order?.contact_name || r.order?.contact_email || 'Order'}
                      </Link>
                      <span className="text-un1t-subtle"> · {SOURCE_LABELS[r.order?.source_type] || r.order?.source_type || ''}</span>
                      <div className="text-[11px] text-un1t-subtle truncate">{r.reason}</div>
                      {r.declined && (
                        <div className="text-[11px] text-red-700 inline-flex items-center gap-1 mt-0.5">
                          <AlertTriangle size={11} /> Revolut declined this refund after it was recorded; the customer was not refunded.
                        </div>
                      )}
                    </div>
                    <div className="text-right whitespace-nowrap">
                      <div className="font-mono tabular-nums">{formatMoney(r.amount_cents, r.currency)}</div>
                      <RefundStatus status={r.status} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  )
}

function Stat({ label, value, sub }) {
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-3">
      <div className="text-[11px] uppercase tracking-wider text-un1t-subtle">{label}</div>
      <div className="text-xl font-semibold text-un1t-text tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-un1t-subtle">{sub}</div>}
    </div>
  )
}

const REFUND_STATUS = {
  completed: ['Done', 'bg-emerald-500/10 text-emerald-700'],
  requested: ['Waiting', 'bg-amber-500/10 text-amber-700'],
  unknown: ['Not confirmed', 'bg-amber-500/10 text-amber-700'],
  failed: ['Refused', 'bg-red-500/10 text-red-700'],
}

function RefundStatus({ status }) {
  const [label, cls] = REFUND_STATUS[status] || [status, 'bg-un1t-border/30 text-un1t-subtle']
  return <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full ${cls}`}>{label}</span>
}
