'use client'

// APPROVALS.1 — central inbox view.
//
// Tabbed list of pending items grouped by category. Source data
// from /api/approvals/pending. Refreshes when the tab regains
// focus + on a manual refresh button. Clicking an item navigates
// to the existing source page where the actual approve/decline
// happens — this view is master/detail-by-link, not inline review.
//
// AGENT-REQ-UX.1 exception: the agent_requests tab decides INLINE
// (AgentRequestDecideCard, same PATCH as everywhere else) — a customer
// is waiting on those, so the extra hop to the settings page was pure
// friction. Other categories keep the link-out model.

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { RefreshCw, ChevronRight } from 'lucide-react'
import AgentRequestDecideCard from '@/components/AgentRequestDecideCard'

function formatDateTime(s) {
  if (!s) return '—'
  try {
    return new Date(s).toLocaleString('en-IE', { dateStyle: 'medium', timeStyle: 'short' })
  } catch { return s }
}

function formatAmount(amount, currency) {
  if (amount == null) return null
  const sym = currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : currency === 'USD' ? '$' : ''
  return `${sym}${Number(amount).toFixed(2)}`
}

export default function ApprovalsInbox() {
  const [providers, setProviders] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [activeKey, setActiveKey] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch('/api/approvals/pending', { cache: 'no-store' })
      const j = await r.json()
      if (!j.success) throw new Error(j.error || 'Failed to load')
      setProviders(j.data.providers || [])
      setTotal(j.data.total || 0)
      // Pick the first non-empty tab on first load, else first tab.
      setActiveKey((prev) => {
        if (prev && (j.data.providers || []).some((p) => p.key === prev)) return prev
        const firstWithItems = (j.data.providers || []).find((p) => p.count > 0)
        return (firstWithItems || j.data.providers?.[0])?.key || null
      })
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Refocus → refresh, so coming back from /schedule/expenses after
  // approving something drops the count without a manual click.
  useEffect(() => {
    const onFocus = () => load()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [load])

  const active = providers.find((p) => p.key === activeKey) || null

  // AGENT-REQ-UX.1 — an inline decision resolved one pending item. Drop the
  // badge counts immediately; the card itself keeps rendering its outcome
  // (the item stays in the list until the next load()/refocus refresh).
  const onItemDecided = useCallback((providerKey) => {
    setProviders((ps) => ps.map((p) => p.key === providerKey ? { ...p, count: Math.max(0, p.count - 1) } : p))
    setTotal((t) => Math.max(0, t - 1))
  }, [])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-1 border border-un1t-border rounded-lg p-1 bg-un1t-bg/40 flex-wrap">
          {providers.map((p) => {
            const isActive = p.key === activeKey
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => setActiveKey(p.key)}
                className={`px-3 py-1.5 text-sm rounded-md transition-colors flex items-center gap-2 ${
                  isActive
                    ? 'bg-un1t-text text-un1t-bg font-medium'
                    : 'text-un1t-subtle hover:text-un1t-text'
                }`}
              >
                {p.label}
                {p.count > 0 && (
                  <span className={`inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-semibold rounded-full ${
                    isActive ? 'bg-un1t-bg text-un1t-text' : 'bg-red-500 text-white'
                  }`}>
                    {p.count > 99 ? '99+' : p.count}
                  </span>
                )}
              </button>
            )
          })}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-un1t-subtle">
            {total === 0 ? 'All clear' : `${total} pending`}
          </span>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="p-1.5 rounded-md border border-un1t-border text-un1t-subtle hover:text-un1t-text disabled:opacity-50"
            aria-label="Refresh"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {error && (
        <div className="border border-red-500/40 bg-red-500/10 text-red-700 rounded-lg p-3 text-sm">
          {error}
        </div>
      )}

      <ProviderList provider={active} loading={loading} onItemDecided={onItemDecided} />
    </div>
  )
}

function ProviderList({ provider, loading, onItemDecided }) {
  if (!provider) {
    return (
      <div className="border border-un1t-border rounded-lg p-8 text-center text-sm text-un1t-subtle">
        {loading ? 'Loading…' : 'Nothing waiting on your review.'}
      </div>
    )
  }
  if (provider.items.length === 0) {
    return (
      <div className="border border-un1t-border rounded-lg p-8 text-center text-sm text-un1t-subtle">
        Nothing pending in {provider.label.toLowerCase()}. <Link href={provider.reviewBase} className="underline">Open {provider.label}</Link>
      </div>
    )
  }
  // AGENT-REQ-UX.1 — agent requests decide in place; a customer is waiting.
  if (provider.key === 'agent_requests') {
    return (
      <div className="space-y-3">
        {provider.items.map((it) => (
          <AgentRequestDecideCard
            key={it.id}
            item={it}
            onDecided={() => onItemDecided?.(provider.key)}
          />
        ))}
      </div>
    )
  }
  return (
    <ul className="border border-un1t-border rounded-lg divide-y divide-un1t-border/50 overflow-hidden">
      {provider.items.map((it) => (
        <li key={it.id}>
          <Link
            href={it.reviewUrl}
            className="flex items-center gap-4 p-4 hover:bg-un1t-text/5 transition-colors"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-un1t-text truncate">{it.title}</span>
                {it.meta && (
                  <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-un1t-border/30 text-un1t-subtle border border-un1t-border">
                    {it.meta}
                  </span>
                )}
              </div>
              <div className="text-xs text-un1t-subtle truncate mt-1">{it.subtitle}</div>
              <div className="text-xs text-un1t-subtle mt-1">
                Submitted {formatDateTime(it.submittedAt)}
              </div>
            </div>
            {formatAmount(it.amount, it.currency) && (
              <div className="text-sm text-un1t-text font-medium tabular-nums">
                {formatAmount(it.amount, it.currency)}
              </div>
            )}
            <ChevronRight size={16} className="text-un1t-subtle shrink-0" />
          </Link>
        </li>
      ))}
    </ul>
  )
}
