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

import { useEffect, useState, useCallback, useRef } from 'react'
import { RefreshCw } from 'lucide-react'
import AgentRequestDecideCard from '@/components/AgentRequestDecideCard'
import TrialPurchaseReviewCard from '@/components/TrialPurchaseReviewCard'
import CorpPromoClaimCard from '@/components/CorpPromoClaimCard'
import OfferPurchaseCard from '@/components/approvals/OfferPurchaseCard'
import BulkClearBar from '@/components/approvals/BulkClearBar'
import UndoClearButton from '@/components/approvals/UndoClearButton'
import { undoWindowOpen } from '@/components/approvals/useUndoWindow'
import { isBulkClearable, runBulkUndo } from '@/lib/approvals/bulk-clear'
import { undoClearRequest } from '@/lib/approvals/undo-clear-request'
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
  // Counts successful loads, so a list can tell "a reload has answered".
  const [loadedCount, setLoadedCount] = useState(0)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    let ok = false
    try {
      // Exempt from the studio-header guard: the list is about the person, not an item.
      const pendingUrl = '/api/approvals/pending'
      const r = await fetch(pendingUrl, { cache: 'no-store' })
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
      ok = true
      setLoadedCount((n) => n + 1)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
    return ok // true when the response arrived and was applied
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

  // APPROVALSQ.5 — a quiet clear was undone: the request is waiting again, so
  // put back the one the decision took off.
  const onItemUndone = useCallback((providerKey) => {
    setProviders((ps) => ps.map((p) => p.key === providerKey ? { ...p, count: p.count + 1 } : p))
    setTotal((t) => t + 1)
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
        ? <CustomerList queue={queue} chip={chip} setChip={setChip} loading={loading} onItemDecided={onItemDecided} onItemUndone={onItemUndone} onReload={load} loadedCount={loadedCount} timezone={timezone} />
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

function CustomerList({ queue, chip, setChip, loading, onItemDecided, onItemUndone, onReload, loadedCount = 0, timezone }) {
  // A chip whose provider vanished on a reload falls back to All.
  const key = queue.chips.some((c) => c.key === chip) ? chip : 'all'
  const { needsFixing: liveNeedsFixing, waiting: liveWaiting } = filterQueue(queue, key)

  // APPROVALSQ.5 — a Mia card cleared quietly stays on the page, with its
  // state and its Undo, for as long as its window is open, even across the
  // reload the clear triggers (the server no longer returns it). Same React key
  // and same list slot as before, so the card keeps its own state. Not counted
  // anywhere: the counts come from `queue`. Once the window has closed, the
  // next reload that no longer returns it drops it. Keyed like the cards.
  const [clearedCards, setClearedCards] = useState(() => new Map())
  const cardKey = (it) => `${it.providerKey}-${it.id}`
  // A later successful reload settles any undone card whose own reload failed.
  useEffect(() => {
    setClearedCards((m) => {
      let next = null
      for (const [k, e] of m) if (e.undone && !e.awaiting) { next = next || new Map(m); next.delete(k) }
      return next || m
    })
  }, [loadedCount])
  const liveKeys = new Set([...liveNeedsFixing, ...liveWaiting].map(cardKey))
  const nowMs = Date.now()
  const keptCleared = [...clearedCards.values()]
    .filter((e) => !liveKeys.has(cardKey(e.item)) && (e.undone || undoWindowOpen(e.at, nowMs)) && (key === 'all' || e.item.providerKey === key))
    .map((e) => e.item)
  const needsFixing = [...liveNeedsFixing, ...keptCleared.filter((i) => i.failed)]
  const waiting = [...liveWaiting, ...keptCleared.filter((i) => !i.failed)]

  // APPROVALSQ.2 — select mode: tick several Mia cards and clear them together.
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState(() => new Set())
  const [decided, setDecided] = useState(() => new Set())
  // `notice` is { error, text, undo?: { ids, at } }: `undo` is on the notice of
  // a bulk clear that cleared something, and its Undo lives while the window
  // (counted from when the run finished) is open.
  const [notice, setNotice] = useState(null)
  const [undoRunning, setUndoRunning] = useState(false)
  const undoInFlight = useRef(false)
  // Switching chip drops the selection (switching view unmounts this list).
  useEffect(() => { setSelected(new Set()) }, [key])

  const clearable = [...needsFixing, ...waiting].filter((i) => isBulkClearable(i) && !decided.has(i.id))
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
      : {
          error: false,
          text: `Cleared ${cleared.length}.${failed.length > 0 ? ` ${failed.length} could not be cleared (already decided, or an error).` : ''}`,
          undo: cleared.length > 0 ? { ids: cleared, at: Date.now() } : null,
        })
    onReload?.()
  }
  // APPROVALSQ.5 — undo the whole bulk clear: one request after another, then
  // reload, then say how many went back. One run per press.
  const undoBulk = async () => {
    const ids = notice?.undo?.ids
    if (undoInFlight.current || !ids?.length) return
    undoInFlight.current = true
    setUndoRunning(true)
    try {
      const { restored, failed } = await runBulkUndo(ids, { undoOne: (id) => undoClearRequest(id) })
      setNotice(restored.length === 0
        ? { error: true, text: 'None could be restored.' }
        : { error: false, text: `Restored ${restored.length}.${failed.length > 0 ? ` ${failed.length} could not be restored.` : ''}` })
      onReload?.()
    } finally {
      undoInFlight.current = false
      setUndoRunning(false)
    }
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
    const onDecided = (_id, request) => {
      if (isBulkClearable(it)) {
        setDecided((prev) => new Set(prev).add(it.id))
        setSelected((prev) => { const next = new Set(prev); next.delete(it.id); return next })
        // The card says it was a quiet clear through the request it got back.
        if (request?.details?.cleared?.silent === true) {
          setClearedCards((m) => new Map(m).set(cardKey(it), { item: it, at: Date.now() }))
        }
      }
      onItemDecided?.(it.providerKey)
    }
    // APPROVALSQ.5 — an undone clear: waiting again and selectable again. The
    // card must not vanish on Undo, so its kept entry stays (same key) while
    // the reload this triggers is answered; then the entry is dropped and the
    // card shows only while the server still returns the request. A failed
    // reload keeps it until the next successful one (the effect above).
    const onUndone = () => {
      setDecided((prev) => { const next = new Set(prev); next.delete(it.id); return next })
      const k = cardKey(it)
      setClearedCards((m) => m.has(k) ? new Map(m).set(k, { item: it, at: Date.now(), undone: true, awaiting: true }) : m)
      Promise.resolve(onReload?.()).then((ok) => {
        setClearedCards((m) => {
          const e = m.get(k)
          if (!e?.undone) return m
          const next = new Map(m)
          if (ok) next.delete(k); else next.set(k, { ...e, awaiting: false })
          return next
        })
      })
      onItemUndone?.(it.providerKey)
    }
    return <Card key={cardKey(it)} item={it} onDecided={onDecided} onUndone={onUndone} timezone={timezone} {...bulk} />
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
        <div className={`${notice.error
          ? 'border border-red-500/40 bg-red-500/10 text-red-700 rounded-lg p-3 text-sm'
          : 'text-sm rounded-md px-3 py-2 bg-un1t-border/30 text-un1t-text'}${notice.undo ? ' flex items-center justify-between gap-3' : ''}`}>
          {notice.undo ? <span>{notice.text}</span> : notice.text}
          {notice.undo && <UndoClearButton startedAt={notice.undo.at} disabled={undoRunning} onClick={undoBulk} />}
        </div>
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
            onClick={() => { setSelectMode(true); setNotice((n) => (n?.undo && undoWindowOpen(n.undo.at) ? n : null)) }}
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
  const live = filterTeamQueue(queue, key)
  // A decided card stays until this view unmounts, so its follow-up question
  // (Keep them rostered / Unassign them, a clash notice) survives the reload
  // that the decision itself triggers. Same React key as before, so the card's
  // own state is kept. Not counted anywhere: the counts come from `queue`.
  const [decided, setDecided] = useState(() => new Map())
  const cardKey = (it) => `${it.providerKey}-${it.id}`
  const liveKeys = new Set(live.map(cardKey))
  const kept = [...decided.values()].filter((it) => !liveKeys.has(cardKey(it)) && (key === 'all' || it.providerKey === key))
  const items = [...live, ...kept]
  const markDecided = (it) => {
    setDecided((m) => (m.has(cardKey(it)) ? m : new Map(m).set(cardKey(it), it)))
    onItemDecided(it.providerKey)
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
                key={cardKey(it)}
                item={it}
                providerKey={it.providerKey}
                providerLabel={it.providerLabel}
                timezone={timezone}
                onDecided={() => markDecided(it)}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
