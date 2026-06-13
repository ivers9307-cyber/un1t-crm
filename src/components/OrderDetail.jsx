'use client'

// OrderDetail — single-order drill-in (Phase 3 follow-up).
// Sections: header (status + amount + buyer), source summary
// (race or car), retry chain, event timeline.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Loader2, AlertCircle, ArrowLeft, ExternalLink, Tag, Calendar, Users, Receipt, Clock, BadgeCheck, Car, Ban } from 'lucide-react'

export default function OrderDetail({ orderId }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(() => {
    fetch(`/api/orders/${orderId}`)
      .then(r => r.json())
      .then(j => {
        if (!j.success) setError(j.error || 'Could not load order')
        else setData(j.data)
      })
      .catch(e => setError(e.message || 'Network error'))
  }, [orderId])

  useEffect(() => { load() }, [load])

  // ORDERS-CANCEL.1 — clear a pending order (e.g. a duplicate attempt).
  const [cancelConfirming, setCancelConfirming] = useState(false)
  const [cancelBusy, setCancelBusy] = useState(false)
  const [cancelError, setCancelError] = useState(null)

  async function handleCancel() {
    setCancelBusy(true)
    setCancelError(null)
    try {
      const r = await fetch(`/api/orders/${orderId}/cancel`, {
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
      load()
    } catch (e) {
      setCancelError(e.message || 'Network error')
      setCancelBusy(false)
    }
  }

  if (error) {
    return (
      <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-md p-3 inline-flex items-start gap-2">
        <AlertCircle size={14} className="mt-0.5 shrink-0" /> {error}
      </div>
    )
  }
  if (!data) {
    return (
      <div className="text-sm text-un1t-subtle inline-flex items-center gap-2">
        <Loader2 size={14} className="animate-spin" /> Loading order…
      </div>
    )
  }

  const { order, retry_chain: chain, events, source } = data

  return (
    <div className="space-y-6">
      <Link href="/orders" className="inline-flex items-center gap-1.5 text-sm text-un1t-subtle hover:text-un1t-text">
        <ArrowLeft size={14} /> Back to Orders
      </Link>

      {/* Header card */}
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-un1t-subtle mb-1">
              {order.source_type === 'race_registration' ? 'Race signup' : 'Car deposit'}
            </div>
            <div className="text-3xl font-bold text-un1t-text tabular-nums">
              {formatMoney(order.amount_cents, order.currency)}
            </div>
            <div className="mt-2"><StatusPill status={order.status} /></div>
            {order.status === 'pending' && (
              <div className="mt-3">
                {!cancelConfirming ? (
                  <button
                    type="button"
                    onClick={() => setCancelConfirming(true)}
                    className="text-xs text-un1t-subtle hover:text-red-700 inline-flex items-center gap-1"
                    title="Clear this pending order (e.g. a duplicate payment attempt)"
                  >
                    <Ban size={12} /> Cancel pending order
                  </button>
                ) : (
                  <div className="inline-flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-un1t-subtle">Clear this pending order?</span>
                    <button
                      type="button"
                      onClick={handleCancel}
                      disabled={cancelBusy}
                      className="text-xs bg-red-600 hover:bg-red-700 text-white px-2 py-1 rounded inline-flex items-center gap-1 disabled:opacity-40"
                    >
                      {cancelBusy ? <Loader2 size={11} className="animate-spin" /> : null}
                      {cancelBusy ? 'Cancelling…' : 'Confirm'}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setCancelConfirming(false); setCancelError(null) }}
                      disabled={cancelBusy}
                      className="text-xs text-un1t-subtle hover:text-un1t-text"
                    >
                      Keep
                    </button>
                  </div>
                )}
                {cancelError && <div className="text-[11px] text-red-700 mt-1">{cancelError}</div>}
              </div>
            )}
          </div>
          <div className="text-right">
            <div className="text-sm text-un1t-text">{order.contact_name || order.contact_email}</div>
            {order.contact_name && (
              <div className="text-xs text-un1t-subtle">{order.contact_email}</div>
            )}
            {order.contact_phone && (
              <div className="text-xs text-un1t-subtle">{order.contact_phone}</div>
            )}
            <div className="text-[11px] text-un1t-muted mt-2">
              Created {fmtDateTime(order.created_at)}
            </div>
            {order.completed_at && (
              <div className="text-[11px] text-un1t-muted">
                Completed {fmtDateTime(order.completed_at)}
              </div>
            )}
            {order.refunded_at && (
              <div className="text-[11px] text-purple-700">
                Refunded {fmtDateTime(order.refunded_at)}
              </div>
            )}
            {order.status === 'cancelled' && order.metadata?.cancelled_at && (
              <div className="text-[11px] text-slate-600">
                Cancelled {fmtDateTime(order.metadata.cancelled_at)}
              </div>
            )}
          </div>
        </div>
        <div className="mt-3 pt-3 border-t border-un1t-border text-[11px] text-un1t-subtle flex items-center gap-3 flex-wrap">
          {order.payment_provider && (
            <span className="inline-flex items-center gap-1">
              <Receipt size={11} /> {order.payment_provider}
            </span>
          )}
          {order.payment_provider_ref && (
            <span className="font-mono">{order.payment_provider_ref}</span>
          )}
          {order.metadata?.refund_reason && (
            <span className="text-purple-700">Reason: {order.metadata.refund_reason}</span>
          )}
        </div>
      </div>

      {/* Source summary */}
      <SourceSummary source={source} />

      {/* Retry chain — each pending line can be cancelled inline so an
          operator can clear out a buyer's duplicate attempts from here. */}
      {chain.length > 1 && (
        <section>
          <h3 className="text-sm font-semibold text-un1t-text mb-2 inline-flex items-center gap-2">
            <Tag size={14} /> Retry chain
          </h3>
          <div className="space-y-2">
            {chain.map((c) => (
              <ChainRow key={c.id} c={c} isCurrent={c.id === order.id} onCancelled={load} />
            ))}
          </div>
        </section>
      )}

      {/* Event timeline */}
      <section>
        <h3 className="text-sm font-semibold text-un1t-text mb-2 inline-flex items-center gap-2">
          <Clock size={14} /> Event timeline
        </h3>
        {events.length === 0 ? (
          <div className="text-xs text-un1t-subtle italic px-2 py-3">No events recorded yet.</div>
        ) : (
          <ol className="border-l border-un1t-border ml-2 space-y-2">
            {events.map((e) => (
              <li key={e.id} className="pl-4 relative">
                <span className="absolute -left-[5px] top-1.5 w-2 h-2 rounded-full bg-un1t-border" />
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-mono text-un1t-text">{e.event_type}</span>
                  <span className="text-[11px] text-un1t-subtle">{fmtDateTime(e.occurred_at)}</span>
                </div>
                {e.event_metadata && (
                  <div className="text-[11px] text-un1t-subtle mt-0.5 font-mono truncate max-w-full">
                    {JSON.stringify(e.event_metadata)}
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}

// One retry-chain row. The info area links to that order; a pending row
// also gets an inline Cancel (ORDERS-CANCEL.1) so the operator can clear
// duplicate attempts without opening each one. onCancelled refetches.
function ChainRow({ c, isCurrent, onCancelled }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  async function cancel() {
    if (busy) return
    if (typeof window !== 'undefined' && !window.confirm('Cancel this pending order? It moves to the Cancelled tab.')) return
    setBusy(true)
    setErr(null)
    try {
      const r = await fetch(`/api/orders/${c.id}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setErr(j.error || `Cancel failed (${r.status})`)
        setBusy(false)
        return
      }
      onCancelled?.()
    } catch (e) {
      setErr(e.message || 'Network error')
      setBusy(false)
    }
  }

  return (
    <div className={`bg-un1t-surface border rounded-md ${isCurrent ? 'border-un1t-text' : 'border-un1t-border'}`}>
      <div className="flex items-center justify-between gap-3 p-3">
        <Link href={`/orders/${c.id}`} className="flex items-center gap-3 flex-1 min-w-0 hover:opacity-80">
          <StatusPill status={c.status} />
          <span className="text-sm text-un1t-text tabular-nums">
            {formatMoney(c.amount_cents, c.currency)}
          </span>
          <span className="text-[11px] text-un1t-subtle">{fmtDateTime(c.created_at)}</span>
          {isCurrent && (
            <span className="text-[10px] uppercase tracking-wider text-un1t-muted">this order</span>
          )}
        </Link>
        <div className="flex items-center gap-3 shrink-0">
          {c.status === 'pending' && (
            <button
              type="button"
              onClick={cancel}
              disabled={busy}
              title="Cancel this pending order"
              className="text-[11px] text-un1t-subtle hover:text-red-700 inline-flex items-center gap-1 disabled:opacity-50"
            >
              {busy ? <Loader2 size={11} className="animate-spin" /> : <Ban size={11} />} Cancel
            </button>
          )}
          <Link href={`/orders/${c.id}`} className="text-un1t-subtle hover:text-un1t-text">
            <ExternalLink size={12} />
          </Link>
        </div>
      </div>
      {err && <div className="text-[11px] text-red-700 px-3 pb-2">{err}</div>}
    </div>
  )
}

function SourceSummary({ source }) {
  if (!source?.kind) return null
  if (source.kind === 'race_registration') {
    const r = source.race_event
    const w = source.wave
    const t = source.team
    const reg = source.registration
    return (
      <section className="bg-un1t-surface border border-un1t-border rounded-lg p-4 space-y-3">
        <h3 className="text-sm font-semibold text-un1t-text inline-flex items-center gap-2">
          <Receipt size={14} /> Race details
        </h3>
        <div className="text-sm text-un1t-text">{r?.name || '(unknown race)'}</div>
        <div className="grid grid-cols-2 gap-2 text-[12px]">
          {r?.race_date && (
            <div className="inline-flex items-center gap-1.5 text-un1t-subtle">
              <Calendar size={12} /> {fmtDate(r.race_date)}
            </div>
          )}
          {w && (
            <div className="inline-flex items-center gap-1.5 text-un1t-subtle">
              <Clock size={12} /> {w.label ? `${w.label} · ` : ''}{(w.start_time || '').slice(0, 5)}
            </div>
          )}
          {t && (
            <div className="inline-flex items-center gap-1.5 text-un1t-subtle">
              <Users size={12} /> Team {t.name} ({t.size}-person)
            </div>
          )}
          {reg && (
            <div className="inline-flex items-center gap-1.5 text-un1t-subtle">
              <Tag size={12} /> {reg.team_composition?.replaceAll('_', ' ')}
            </div>
          )}
        </div>
        {t?.team_members?.length > 0 && (
          <div className="pt-2 border-t border-un1t-border">
            <div className="text-[11px] uppercase tracking-wider text-un1t-subtle mb-1">Roster</div>
            <ul className="text-[12px] text-un1t-text space-y-0.5">
              {t.team_members.map((m) => (
                <li key={m.id} className="inline-flex items-center gap-1.5 mr-3">
                  {m.name}
                  {m.role === 'captain' && <span className="text-amber-700 text-[10px]">★</span>}
                  {m.is_member && <BadgeCheck size={11} className="text-emerald-700" />}
                </li>
              ))}
            </ul>
          </div>
        )}
        {r?.slug && (
          <div className="pt-2">
            <Link href={`/events`} className="text-xs text-un1t-subtle hover:text-un1t-text inline-flex items-center gap-1">
              View race &rarr;
            </Link>
          </div>
        )}
      </section>
    )
  }
  if (source.kind === 'car_deposit') {
    const c = source.car
    return (
      <section className="bg-un1t-surface border border-un1t-border rounded-lg p-4 space-y-2">
        <h3 className="text-sm font-semibold text-un1t-text inline-flex items-center gap-2">
          <Car size={14} /> Car details
        </h3>
        <div className="text-sm text-un1t-text">
          {[c?.make, c?.model].filter(Boolean).join(' ') || '(unknown vehicle)'}
        </div>
        {c?.irish_reg && (
          <div className="text-[12px] text-un1t-subtle font-mono">{c.irish_reg}</div>
        )}
        <div className="grid grid-cols-2 gap-2 text-[12px] text-un1t-subtle pt-2 border-t border-un1t-border">
          {c?.deposit_status && (
            <div>Deposit status: <span className="text-un1t-text">{c.deposit_status}</span></div>
          )}
          {c?.deposit_amount != null && (
            <div>Deposit amount: <span className="text-un1t-text">€{Number(c.deposit_amount).toFixed(2)}</span></div>
          )}
          {c?.deposit_link_sent_at && (
            <div>Link sent: <span className="text-un1t-text">{fmtDateTime(c.deposit_link_sent_at)}</span></div>
          )}
          {c?.deposit_paid_at && (
            <div>Paid: <span className="text-un1t-text">{fmtDateTime(c.deposit_paid_at)}</span></div>
          )}
        </div>
        {c?.id && (
          <div className="pt-2">
            <Link href={`/cars/${c.id}`} className="text-xs text-un1t-subtle hover:text-un1t-text inline-flex items-center gap-1">
              View car &rarr;
            </Link>
          </div>
        )}
      </section>
    )
  }
  return null
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

function fmtDateTime(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString('en-IE', {
      timeZone: 'Europe/Dublin',
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  } catch { return String(iso) }
}

function fmtDate(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString('en-IE', {
      day: 'numeric', month: 'short', year: 'numeric',
    })
  } catch { return String(iso) }
}
