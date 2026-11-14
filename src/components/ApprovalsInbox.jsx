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
import TrialPurchaseReviewCard from '@/components/TrialPurchaseReviewCard'
import CorpPromoClaimCard from '@/components/CorpPromoClaimCard'
import OfferPurchaseCard from '@/components/approvals/OfferPurchaseCard'
import { buildCustomerQueue, filterQueue, teamProviders } from '@/lib/approvals/customer-queue'

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
  const [view, setView] = useState(null) // 'customers' | 'team'; chosen on first load
  const [chip, setChip] = useState('all')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch('/api/approvals/pending', { cache: 'no-store' })
      const j = await r.json()
      if (!j.success) throw new Error(j.error || 'Failed to load')
      setProviders(j.data.providers || [])
      setTotal(j.data.total || 0)
      // Pick the first non-empty team tab on first load, else first tab.
      const team = teamProviders(j.data.providers || [])
      setActiveKey((prev) => {
        if (prev && team.some((p) => p.key === prev)) return prev
        const firstWithItems = team.find((p) => p.count > 0)
        return (firstWithItems || team[0])?.key || null
      })
      // Open on Customers when something waits there or there is no team view.
      setView((prev) => {
        if (prev) return prev
        const q = buildCustomerQueue(j.data.providers || [])
        return q.total > 0 || team.length === 0 ? 'customers' : 'team'
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

  const team = teamProviders(providers)
  const queue = buildCustomerQueue(providers)
  const hasCustomers = queue.chips.length > 0
  const teamCount = team.reduce((sum, p) => sum + (p.count || 0), 0)
  const hasTeam = team.length > 0
  const shownView = view === 'team' && hasTeam ? 'team'
    : view === 'customers' && hasCustomers ? 'customers'
      : hasCustomers ? 'customers' : 'team'
  const active = team.find((p) => p.key === activeKey) || null

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
        <div className="flex items-center gap-3 flex-wrap">
          {hasCustomers && hasTeam && (
            <div className="flex items-center gap-1 border border-un1t-border rounded-lg p-1 bg-un1t-bg/40">
              <ViewButton active={shownView === 'customers'} count={queue.total} onClick={() => setView('customers')}>Customers</ViewButton>
              <ViewButton active={shownView === 'team'} count={teamCount} onClick={() => setView('team')}>Team and money</ViewButton>
            </div>
          )}
          {shownView === 'team' && (
        <div className="flex items-center gap-1 border border-un1t-border rounded-lg p-1 bg-un1t-bg/40 flex-wrap">
          {team.map((p) => {
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
          )}
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

      {shownView === 'customers'
        ? <CustomerList queue={queue} chip={chip} setChip={setChip} loading={loading} onItemDecided={onItemDecided} />
        : <ProviderList provider={active} loading={loading} />}
    </div>
  )
}

function Badge({ count, active }) {
  if (!(count > 0)) return null
  return (
    <span className={`inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-semibold rounded-full ${
      active ? 'bg-un1t-bg text-un1t-text' : 'bg-red-500 text-white'
    }`}>
      {count > 99 ? '99+' : count}
    </span>
  )
}

function ViewButton({ active, count, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 text-sm rounded-md transition-colors flex items-center gap-2 ${
        active ? 'bg-un1t-text text-un1t-bg font-medium' : 'text-un1t-subtle hover:text-un1t-text'
      }`}
    >
      {children}
      <Badge count={count} active={active} />
    </button>
  )
}

const CARDS = {
  agent_requests: AgentRequestDecideCard,
  trial_purchases: TrialPurchaseReviewCard,
  corp_promo_claims: CorpPromoClaimCard,
  offer_purchases: OfferPurchaseCard,
}

function CustomerList({ queue, chip, setChip, loading, onItemDecided }) {
  // A chip whose provider vanished on a reload falls back to All.
  const key = queue.chips.some((c) => c.key === chip) ? chip : 'all'
  const { needsFixing, waiting } = filterQueue(queue, key)
  const renderCard = (it) => {
    const Card = CARDS[it.providerKey]
    if (!Card) return null
    return <Card key={`${it.providerKey}-${it.id}`} item={it} onDecided={() => onItemDecided?.(it.providerKey)} />
  }
  const chipClass = (on) => `px-3 py-1 text-xs rounded-full border transition-colors flex items-center gap-1.5 ${
    on ? 'bg-un1t-text text-un1t-bg border-un1t-text font-medium' : 'border-un1t-border text-un1t-subtle hover:text-un1t-text'
  }`
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <button type="button" onClick={() => setChip('all')} className={chipClass(key === 'all')}>
          All <span className="tabular-nums">{queue.total}</span>
        </button>
        {queue.chips.map((c) => (
          <button key={c.key} type="button" onClick={() => setChip(c.key)} className={chipClass(key === c.key)}>
            {c.label} <span className="tabular-nums">{c.count}</span>
          </button>
        ))}
      </div>
      {needsFixing.length === 0 && waiting.length === 0 ? (
        <div className="border border-un1t-border rounded-lg p-8 text-center text-sm text-un1t-subtle">
          {loading ? 'Loading…' : 'Nothing waiting on customers.'}
        </div>
      ) : (
        <div className="space-y-3">
          {needsFixing.length > 0 && (
            <p className="text-xs font-semibold text-red-700 uppercase tracking-wider">Needs fixing</p>
          )}
          {needsFixing.map(renderCard)}
          {needsFixing.length > 0 && waiting.length > 0 && (
            <p className="text-xs font-semibold text-un1t-subtle uppercase tracking-wider pt-2">Waiting</p>
          )}
          {waiting.map(renderCard)}
        </div>
      )}
    </div>
  )
}

function ProviderList({ provider, loading }) {
  if (!provider) {
    return (
      <div className="border border-un1t-border rounded-lg p-8 text-center text-sm text-un1t-subtle">
        {loading ? 'Loading…' : 'Nothing waiting on your review.'}
      </div>
    )
  }
  const failedItems = provider.failedItems || []
  if (provider.items.length === 0 && failedItems.length === 0) {
    return (
      <div className="border border-un1t-border rounded-lg p-8 text-center text-sm text-un1t-subtle">
        Nothing pending in {provider.label.toLowerCase()}. <Link href={provider.reviewBase} className="underline">Open {provider.label}</Link>
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
              {/* LEAVE.1 — e.g. "Clashes with 2 rostered shifts" on time off. */}
              {it.warning && (
                <div className="text-xs text-amber-700 mt-1">{it.warning}</div>
              )}
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
