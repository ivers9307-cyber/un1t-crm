'use client'

// APPROVALS.1 — central inbox view.
//
// Two views over /api/approvals/pending, refreshed when the tab regains focus
// and on a manual refresh. Customers: everything a customer is waiting on
// (agent requests, paid trials, corporate promo claims, offer purchases) as
// one queue of cards that are decided in place, with filters. Team and money
// (APPROVALSQ.4): the staff-side categories (leave, expenses, invoices and so
// on) as one list, oldest first, with filter chips. Six kinds are decided on
// their card; the rest show an Open button to their own page.

import { useEffect, useState, useCallback, useMemo } from 'react'
import { RefreshCw } from 'lucide-react'
import AgentRequestDecideCard from '@/components/AgentRequestDecideCard'
import TrialPurchaseReviewCard from '@/components/TrialPurchaseReviewCard'
import CorpPromoClaimCard from '@/components/CorpPromoClaimCard'
import OfferPurchaseCard from '@/components/approvals/OfferPurchaseCard'
import BulkClearBar from '@/components/approvals/BulkClearBar'
import { isBulkClearable } from '@/lib/approvals/bulk-clear'
import { TEAM_CARDS, TeamLinkCard } from '@/components/approvals/team-cards'
import { buildCustomerQueue, filterQueue, teamProviders } from '@/lib/approvals/customer-queue'
import { buildTeamQueue, filterTeamQueue } from '@/lib/approvals/team-queue'

export default function ApprovalsInbox({ timezone = null }) {
  const [providers, setProviders] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [view, setView] = useState(null) // 'customers' | 'team'; chosen on first load
  const [chip, setChip] = useState('all')
  const [teamChip, setTeamChip] = useState('all')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch('/api/approvals/pending', { cache: 'no-store' })
      const j = await r.json()
      if (!j.success) throw new Error(j.error || 'Failed to load')
      setProviders(j.data.providers || [])
      setTotal(j.data.total || 0)
      const team = teamProviders(j.data.providers || [])
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
  const teamQueue = buildTeamQueue(providers)
  const hasCustomers = queue.chips.length > 0
  const teamCount = team.reduce((sum, p) => sum + (p.count || 0), 0)
  const hasTeam = team.length > 0
  const shownView = view === 'team' && hasTeam ? 'team'
    : view === 'customers' && hasCustomers ? 'customers'
      : hasCustomers ? 'customers' : 'team'

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
        ? <CustomerList queue={queue} chip={chip} setChip={setChip} loading={loading} onItemDecided={onItemDecided} onReload={load} timezone={timezone} />
        : <TeamList queue={teamQueue} chip={teamChip} setChip={setTeamChip} loading={loading} onItemDecided={onItemDecided} timezone={timezone} />}
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

const chipClass = (on) => `px-3 py-1 text-xs rounded-full border transition-colors flex items-center gap-1.5 ${
  on ? 'bg-un1t-text text-un1t-bg border-un1t-text font-medium' : 'border-un1t-border text-un1t-subtle hover:text-un1t-text'
}`

function CustomerList({ queue, chip, setChip, loading, onItemDecided, onReload, timezone }) {
  // A chip whose provider vanished on a reload falls back to All.
  const key = queue.chips.some((c) => c.key === chip) ? chip : 'all'
  const { needsFixing, waiting } = filterQueue(queue, key)

  // APPROVALSQ.2 — select mode: tick several Mia cards and clear them together.
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState(() => new Set())
  const [decided, setDecided] = useState(() => new Set())
  const [notice, setNotice] = useState(null)
  // Switching chip drops the selection (switching view unmounts this list).
  useEffect(() => { setSelected(new Set()) }, [key])

  const clearable = useMemo(
    () => [...needsFixing, ...waiting].filter((i) => isBulkClearable(i) && !decided.has(i.id)),
    [needsFixing, waiting, decided],
  )
  const selectedItems = clearable.filter((i) => selected.has(i.id))
  const leaveSelect = () => { setSelectMode(false); setSelected(new Set()) }
  const toggle = (id) => setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const finished = ({ cleared, failed }) => {
    leaveSelect()
    setNotice(cleared.length === 0 && failed.length > 0
      ? { error: true, text: 'None could be cleared (already decided, or an error).' }
      : { error: false, text: `Cleared ${cleared.length}.${failed.length > 0 ? ` ${failed.length} could not be cleared (already decided, or an error).` : ''}` })
    onReload?.()
  }

  const renderCard = (it) => {
    const Card = CARDS[it.providerKey]
    if (!Card) return null
    const bulk = isBulkClearable(it)
      ? {
          selectable: selectMode && !decided.has(it.id),
          selected: selected.has(it.id),
          onToggle: () => toggle(it.id),
        }
      : {}
    const onDecided = () => {
      if (isBulkClearable(it)) {
        setDecided((prev) => new Set(prev).add(it.id))
        setSelected((prev) => { const next = new Set(prev); next.delete(it.id); return next })
      }
      onItemDecided?.(it.providerKey)
    }
    return <Card key={`${it.providerKey}-${it.id}`} item={it} onDecided={onDecided} timezone={timezone} {...bulk} />
  }
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
      {notice && !selectMode && (
        <div className={notice.error
          ? 'border border-red-500/40 bg-red-500/10 text-red-700 rounded-lg p-3 text-sm'
          : 'text-sm rounded-md px-3 py-2 bg-un1t-border/30 text-un1t-text'}>{notice.text}</div>
      )}
      {selectMode ? (
        <BulkClearBar
          items={selectedItems}
          onSelectAll={() => setSelected(new Set(clearable.map((i) => i.id)))}
          onCancel={leaveSelect}
          onFinished={finished}
        />
      ) : clearable.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => { setSelectMode(true); setNotice(null) }}
            className="px-3 py-1 text-xs rounded-md border border-un1t-border text-un1t-subtle hover:text-un1t-text"
          >
            Select
          </button>
        </div>
      )}
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

function TeamList({ queue, chip, setChip, loading, onItemDecided, timezone }) {
  // A chip whose provider vanished on a reload falls back to All.
  const key = queue.chips.some((c) => c.key === chip) ? chip : 'all'
  const items = filterTeamQueue(queue, key)
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
      {items.length === 0 ? (
        <div className="border border-un1t-border rounded-lg p-8 text-center text-sm text-un1t-subtle">
          {loading ? 'Loading…' : 'Nothing waiting on your review.'}
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((it) => {
            const Card = TEAM_CARDS[it.providerKey] || TeamLinkCard
            return (
              <Card
                key={`${it.providerKey}-${it.id}`}
                item={it}
                providerKey={it.providerKey}
                providerLabel={it.providerLabel}
                timezone={timezone}
                onDecided={() => onItemDecided(it.providerKey)}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
