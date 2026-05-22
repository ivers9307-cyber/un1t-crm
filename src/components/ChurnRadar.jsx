'use client'

// CHURN-RADAR.1 — the at-risk member radar dashboard.
//
// Four tabs:
//   At Risk    — scored active members + per-member win-back actions.
//   Win-back   — former members (lapsed 45–365 days) worth re-winning.
//   Overdue    — live members whose payment has failed; a chase-list.
//   Quarantine — zero-activity "ghost member" records for bulk triage.
//
// All data comes from /api/churn-radar/*; this component is pure UI +
// fetch orchestration.

import { useEffect, useState, useCallback } from 'react'
import {
  Radar, AlertTriangle, Clock, TrendingDown, UserX, Phone,
  ClipboardList, MessageCircle, BellOff, Check, CalendarClock, RotateCcw,
  CreditCard, Ticket,
} from 'lucide-react'

const TIER_STYLE = {
  high:   { label: 'High',   cls: 'bg-red-100 text-red-700' },
  medium: { label: 'Medium', cls: 'bg-amber-100 text-amber-700' },
  low:    { label: 'Low',    cls: 'bg-un1t-gray text-un1t-light' },
}

const SIGNAL_ICON = {
  gone_quiet: Clock,
  disengaging: TrendingDown,
  no_show: UserX,
  renewal_cliff: CalendarClock,
  pack_low: Ticket,
}

function formatMoney(cents) {
  const n = Math.round((Number(cents) || 0) / 100)
  return `€${n.toLocaleString('en-IE')}`
}

function timeAgo(iso) {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 86_400_000) return 'today'
  const d = Math.floor(ms / 86_400_000)
  return d === 1 ? '1 day ago' : `${d} days ago`
}

function formatJoined(iso) {
  if (!iso) return 'unknown'
  return new Date(iso).toLocaleDateString('en-IE', { month: 'short', year: 'numeric' })
}

export default function ChurnRadar() {
  const [tab, setTab] = useState('radar')
  const [radar, setRadar] = useState(null)
  const [quarantine, setQuarantine] = useState(null)
  const [winback, setWinback] = useState(null)
  const [overdue, setOverdue] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)        // contactId mid-action
  const [flash, setFlash] = useState(null)      // transient result banner
  const [selected, setSelected] = useState(() => new Set())

  const loadRadar = useCallback(async () => {
    setError(null)
    try {
      const r = await fetch('/api/churn-radar', { cache: 'no-store' })
      const j = await r.json()
      if (!r.ok || !j.success) throw new Error(j.error || 'Failed to load radar')
      setRadar(j.data)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadQuarantine = useCallback(async () => {
    try {
      const r = await fetch('/api/churn-radar/quarantine', { cache: 'no-store' })
      const j = await r.json()
      if (!r.ok || !j.success) throw new Error(j.error || 'Failed to load quarantine')
      setQuarantine(j.data.items)
    } catch (e) {
      setError(e.message)
    }
  }, [])

  const loadWinback = useCallback(async () => {
    try {
      const r = await fetch('/api/churn-radar/winback', { cache: 'no-store' })
      const j = await r.json()
      if (!r.ok || !j.success) throw new Error(j.error || 'Failed to load win-back')
      setWinback(j.data)
    } catch (e) {
      setError(e.message)
    }
  }, [])

  const loadOverdue = useCallback(async () => {
    try {
      const r = await fetch('/api/churn-radar/overdue', { cache: 'no-store' })
      const j = await r.json()
      if (!r.ok || !j.success) throw new Error(j.error || 'Failed to load overdue')
      setOverdue(j.data)
    } catch (e) {
      setError(e.message)
    }
  }, [])

  useEffect(() => { loadRadar() }, [loadRadar])
  useEffect(() => {
    if (tab === 'quarantine' && quarantine === null) loadQuarantine()
    if (tab === 'winback' && winback === null) loadWinback()
    if (tab === 'overdue' && overdue === null) loadOverdue()
  }, [tab, quarantine, winback, overdue, loadQuarantine, loadWinback, loadOverdue])

  function showFlash(msg, ok = true) {
    setFlash({ msg, ok })
    setTimeout(() => setFlash(null), 5000)
  }

  async function runAction(contactId, action, extra = {}) {
    setBusy(contactId)
    try {
      const r = await fetch('/api/churn-radar/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contact_id: contactId, action, ...extra }),
      })
      const j = await r.json()
      if (!r.ok || !j.success) throw new Error(j.error || 'Action failed')
      showFlash(ACTION_DONE[action] || 'Done')
      await loadRadar()
      if (winback !== null) await loadWinback()
      if (overdue !== null) await loadOverdue()
    } catch (e) {
      showFlash(e.message, false)
    } finally {
      setBusy(null)
    }
  }

  async function runQuarantine(decision) {
    const ids = [...selected]
    if (ids.length === 0) return
    setBusy('quarantine')
    try {
      const r = await fetch('/api/churn-radar/quarantine', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contact_ids: ids, decision }),
      })
      const j = await r.json()
      if (!r.ok || !j.success) throw new Error(j.error || 'Triage failed')
      showFlash(`${j.data.triaged} record${j.data.triaged === 1 ? '' : 's'} ${decision === 'stale' ? 'marked stale' : 'kept'}`)
      setSelected(new Set())
      await loadQuarantine()
      await loadRadar()  // summary's quarantine count changed
    } catch (e) {
      showFlash(e.message, false)
    } finally {
      setBusy(null)
    }
  }

  function toggleSelect(id) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  if (loading) return <p className="text-sm text-un1t-light">Loading radar…</p>

  const summary = radar?.summary || {
    activeBase: 0, atRisk: 0, highRisk: 0, quarantine: 0, paused: 0, overdue: 0,
    snoozed: 0, revenueAtRiskCents: 0, overdueValueCents: 0,
    bySegment: { member: {}, credit: {} },
  }
  const seg = summary.bySegment || { member: {}, credit: {} }
  const splitLine = (key) =>
    `${seg.member?.[key] || 0} members · ${seg.credit?.[key] || 0} packs`

  return (
    <div>
      {flash && (
        <p className={`mb-4 rounded-lg border p-3 text-sm ${
          flash.ok
            ? 'border-green-200 bg-green-50 text-green-800'
            : 'border-red-200 bg-red-50 text-red-800'
        }`}>
          {flash.msg}
        </p>
      )}
      {error && (
        <p className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>
      )}

      {/* Summary cards — the Active base is every live membership
          (active, paused, overdue and quarantine alike), split into
          subscriptions vs class packs. Overdue is a chase-list of
          members whose payment has failed. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7 mb-6">
        <StatCard label="Active base" value={summary.activeBase} breakdown={splitLine('activeBase')} />
        <StatCard label="At risk" value={summary.atRisk} accent="amber" breakdown={splitLine('atRisk')} />
        <StatCard label="Revenue at risk" value={formatMoney(summary.revenueAtRiskCents)} accent="amber" breakdown="per month, at-risk" />
        <StatCard label="High risk" value={summary.highRisk} accent="red" />
        <StatCard label="Overdue" value={summary.overdue} accent="red" breakdown={`${formatMoney(summary.overdueValueCents)}/mo owed`} />
        <StatCard label="Paused" value={summary.paused} breakdown="planned freeze" />
        <StatCard label="Quarantine" value={summary.quarantine} />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-un1t-gray mb-4">
        <Tab active={tab === 'radar'} onClick={() => setTab('radar')}
          icon={Radar} label={`At Risk (${radar?.radar?.length || 0})`} />
        <Tab active={tab === 'winback'} onClick={() => setTab('winback')}
          icon={RotateCcw} label={`Win-back${winback ? ` (${winback.winback.length})` : ''}`} />
        <Tab active={tab === 'overdue'} onClick={() => setTab('overdue')}
          icon={CreditCard} label={`Overdue (${summary.overdue})`} />
        <Tab active={tab === 'quarantine'} onClick={() => setTab('quarantine')}
          icon={AlertTriangle}
          label={`Quarantine (${quarantine ? quarantine.length : summary.quarantine})`} />
      </div>

      {tab === 'radar' && (
        <RadarList radar={radar?.radar || []} busy={busy} onAction={runAction}
          snoozed={summary.snoozed} />
      )}

      {tab === 'winback' && (
        <WinbackList data={winback} busy={busy} onAction={runAction} />
      )}

      {tab === 'overdue' && (
        <OverdueList data={overdue} busy={busy} onAction={runAction} />
      )}

      {tab === 'quarantine' && (
        <Quarantine items={quarantine} selected={selected} busy={busy}
          onToggle={toggleSelect} onSelectAll={(all) => setSelected(all ? new Set((quarantine || []).map((q) => q.contactId)) : new Set())}
          onTriage={runQuarantine} />
      )}
    </div>
  )
}

const ACTION_DONE = {
  contacted: 'Logged as contacted',
  task_assigned: 'Follow-up task created',
  winback_sent: 'Win-back message sent',
  snoozed: 'Snoozed for 14 days',
}

// ── small pieces ─────────────────────────────────────────────────

function StatCard({ label, value, accent, breakdown }) {
  const valueCls = accent === 'red' ? 'text-red-600'
    : accent === 'amber' ? 'text-amber-600' : 'text-un1t-white'
  return (
    <div className="rounded-xl border border-un1t-gray bg-white p-4">
      <p className="text-xs text-un1t-light">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${valueCls}`}>{value}</p>
      {breakdown && <p className="mt-0.5 text-[11px] text-un1t-mid">{breakdown}</p>}
    </div>
  )
}

function Tab({ active, onClick, icon: Icon, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px ${
        active
          ? 'border-un1t-white text-un1t-white'
          : 'border-transparent text-un1t-light hover:text-un1t-white'
      }`}
    >
      <Icon size={15} />
      {label}
    </button>
  )
}

function RadarList({ radar, busy, onAction, snoozed }) {
  if (radar.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-un1t-gray p-10 text-center">
        <Radar size={28} className="mx-auto text-un1t-light" />
        <p className="mt-3 font-medium text-un1t-white">Nobody at risk right now</p>
        <p className="mt-1 text-sm text-un1t-light">
          Every active member is attending normally. The radar refreshes nightly.
        </p>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      {snoozed > 0 && (
        <p className="text-xs text-un1t-mid">{snoozed} member{snoozed === 1 ? '' : 's'} snoozed and hidden.</p>
      )}
      {radar.map((m) => <RadarRow key={m.contactId} m={m} busy={busy} onAction={onAction} />)}
    </div>
  )
}

function RadarRow({ m, busy, onAction }) {
  const tier = TIER_STYLE[m.tier] || TIER_STYLE.low
  const isBusy = busy === m.contactId
  return (
    <div className="rounded-lg border border-un1t-gray bg-un1t-dark p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <a href={`/contacts/${m.contactId}`} className="font-medium text-un1t-white hover:underline">
              {m.name}
            </a>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${tier.cls}`}>
              {tier.label} · {m.score}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-un1t-light">
            {m.membershipPlan || m.membershipStatus}
            {m.monthlyValueCents > 0 && ` · ${formatMoney(m.monthlyValueCents)}/mo`}
            {m.daysSinceAttended != null && ` · last class ${m.daysSinceAttended}d ago`}
            {m.daysToRenewal != null && ` · renews in ${m.daysToRenewal}d`}
            {m.lastContacted && ` · contacted ${timeAgo(m.lastContacted.at)}`}
          </p>
        </div>
      </div>

      {/* Signal chips */}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {m.signals.map((s) => {
          const Icon = SIGNAL_ICON[s.key] || AlertTriangle
          const cls = s.severity === 'critical'
            ? 'bg-red-50 text-red-700 border-red-200'
            : 'bg-amber-50 text-amber-700 border-amber-200'
          return (
            <span key={s.key} className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] ${cls}`}>
              <Icon size={12} />
              <span className="font-medium">{s.label}</span>
              <span className="opacity-70">· {s.detail}</span>
            </span>
          )
        })}
      </div>

      {/* Actions */}
      <div className="mt-3 flex flex-wrap gap-2">
        <ActionBtn icon={Phone} label="Mark contacted" disabled={isBusy}
          onClick={() => onAction(m.contactId, 'contacted')} />
        <ActionBtn icon={ClipboardList} label="Assign task" disabled={isBusy}
          onClick={() => onAction(m.contactId, 'task_assigned')} />
        <ActionBtn icon={MessageCircle} label="Win-back" disabled={isBusy} primary
          onClick={() => onAction(m.contactId, 'winback_sent')} />
        <ActionBtn icon={BellOff} label="Snooze" disabled={isBusy}
          onClick={() => onAction(m.contactId, 'snoozed')} />
      </div>
    </div>
  )
}

function ActionBtn({ icon: Icon, label, onClick, disabled, primary }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${
        primary
          ? 'bg-indigo-600 text-white hover:bg-indigo-500'
          : 'border border-un1t-gray bg-un1t-black text-un1t-light hover:text-un1t-white'
      }`}
    >
      <Icon size={13} />
      {label}
    </button>
  )
}

function Quarantine({ items, selected, busy, onToggle, onSelectAll, onTriage }) {
  if (items === null) return <p className="text-sm text-un1t-light">Loading quarantine…</p>
  if (items.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-un1t-gray p-10 text-center">
        <Check size={28} className="mx-auto text-green-500" />
        <p className="mt-3 font-medium text-un1t-white">Quarantine is clear</p>
        <p className="mt-1 text-sm text-un1t-light">Every member has activity data or has been triaged.</p>
      </div>
    )
  }
  const allSelected = selected.size === items.length
  const isBusy = busy === 'quarantine'
  return (
    <div>
      <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
        These members are tagged as paying in Glofox but have <strong>no class attendance and no bookings</strong> —
        most are stale records. Review and mark them stale (reclassified to dormant) or keep them.
      </p>
      <div className="mb-2 flex items-center justify-between">
        <label className="inline-flex items-center gap-2 text-xs text-un1t-light">
          <input type="checkbox" checked={allSelected} onChange={(e) => onSelectAll(e.target.checked)} />
          Select all ({items.length})
        </label>
        {selected.size > 0 && (
          <div className="flex gap-2">
            <button type="button" disabled={isBusy} onClick={() => onTriage('keep')}
              className="rounded-md border border-un1t-gray bg-un1t-black px-2.5 py-1 text-xs font-medium text-un1t-light hover:text-un1t-white disabled:opacity-50">
              Keep {selected.size}
            </button>
            <button type="button" disabled={isBusy} onClick={() => onTriage('stale')}
              className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50">
              Mark {selected.size} stale
            </button>
          </div>
        )}
      </div>
      <ul className="space-y-1.5">
        {items.map((q) => (
          <li key={q.contactId}
            className="flex items-center gap-3 rounded-lg border border-un1t-gray bg-un1t-dark p-3">
            <input type="checkbox" checked={selected.has(q.contactId)} onChange={() => onToggle(q.contactId)} />
            <div className="min-w-0 flex-1">
              <a href={`/contacts/${q.contactId}`} className="text-sm font-medium text-un1t-white hover:underline">
                {q.name}
              </a>
              <p className="text-xs text-un1t-light">
                {q.membershipPlan || q.membershipStatus} · joined {formatJoined(q.joinedAt)}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── win-back ─────────────────────────────────────────────────────

function WinbackList({ data, busy, onAction }) {
  if (data === null) return <p className="text-sm text-un1t-light">Loading win-back…</p>
  const rows = data.winback || []
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-un1t-gray p-10 text-center">
        <RotateCcw size={28} className="mx-auto text-un1t-light" />
        <p className="mt-3 font-medium text-un1t-white">No win-back candidates</p>
        <p className="mt-1 text-sm text-un1t-light">
          No former members in the 45–365 day window. Members appear here once
          they lapse past the at-risk stage.
        </p>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      <p className="mb-1 rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-xs text-indigo-800">
        Former members who trained but have now lapsed — last class 45–365 days
        ago. Warmest (most recently lapsed, highest value) first.
      </p>
      {data.summary?.snoozed > 0 && (
        <p className="text-xs text-un1t-mid">{data.summary.snoozed} snoozed and hidden.</p>
      )}
      {rows.map((m) => <WinbackRow key={m.contactId} m={m} busy={busy} onAction={onAction} />)}
    </div>
  )
}

function WinbackRow({ m, busy, onAction }) {
  const tier = TIER_STYLE[m.tier] || TIER_STYLE.low
  const isBusy = busy === m.contactId
  return (
    <div className="rounded-lg border border-un1t-gray bg-un1t-dark p-4">
      <div className="flex items-center gap-2">
        <a href={`/contacts/${m.contactId}`} className="font-medium text-un1t-white hover:underline">
          {m.name}
        </a>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${tier.cls}`}>
          {tier.label}
        </span>
      </div>
      <p className="mt-0.5 text-xs text-un1t-light">
        {m.membershipPlan || m.status?.replace(/_/g, ' ')}
        {` · last class ${m.daysSinceAttended}d ago`}
        {m.monthlyValueCents > 0 && ` · ${formatMoney(m.monthlyValueCents)}/mo`}
        {m.lifetimeValueCents > 0 && ` · ${formatMoney(m.lifetimeValueCents)} LTV`}
        {m.lastContacted && ` · contacted ${timeAgo(m.lastContacted.at)}`}
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <ActionBtn icon={Phone} label="Mark contacted" disabled={isBusy}
          onClick={() => onAction(m.contactId, 'contacted')} />
        <ActionBtn icon={MessageCircle} label="Win-back" disabled={isBusy} primary
          onClick={() => onAction(m.contactId, 'winback_sent')} />
        <ActionBtn icon={BellOff} label="Snooze" disabled={isBusy}
          onClick={() => onAction(m.contactId, 'snoozed')} />
      </div>
    </div>
  )
}

// ── overdue ──────────────────────────────────────────────────────

function OverdueList({ data, busy, onAction }) {
  if (data === null) return <p className="text-sm text-un1t-light">Loading overdue…</p>
  const rows = data.overdue || []
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-un1t-gray p-10 text-center">
        <Check size={28} className="mx-auto text-green-500" />
        <p className="mt-3 font-medium text-un1t-white">Nobody overdue</p>
        <p className="mt-1 text-sm text-un1t-light">
          Every live membership is paid up. Members appear here when a Glofox
          payment fails.
        </p>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      <p className="mb-1 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800">
        Live members whose Glofox payment has <strong>failed</strong> — they still
        hold a membership but owe money on it. Highest monthly value first; open a
        profile for their contact details.
      </p>
      {rows.map((m) => <OverdueRow key={m.contactId} m={m} busy={busy} onAction={onAction} />)}
    </div>
  )
}

function OverdueRow({ m, busy, onAction }) {
  const isBusy = busy === m.contactId
  const attendLine = m.daysSinceAttended == null
    ? 'no class history'
    : m.daysSinceAttended <= 30
      ? `still training — last class ${m.daysSinceAttended}d ago`
      : `last class ${m.daysSinceAttended}d ago`
  return (
    <div className="rounded-lg border border-un1t-gray bg-un1t-dark p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <a href={`/contacts/${m.contactId}`} className="font-medium text-un1t-white hover:underline">
              {m.name}
            </a>
            <span className="rounded-full bg-un1t-gray px-2 py-0.5 text-[10px] font-semibold uppercase text-un1t-light">
              {m.segment === 'credit' ? 'Pack' : 'Member'}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-un1t-light">
            {m.membershipPlan || m.membershipStatus}
            {m.monthlyValueCents > 0 && ` · ${formatMoney(m.monthlyValueCents)}/mo`}
            {` · ${attendLine}`}
            {m.lastContacted && ` · contacted ${timeAgo(m.lastContacted.at)}`}
          </p>
        </div>
        <span className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700">
          <CreditCard size={12} />
          {m.daysSincePayment == null
            ? 'No payment on record'
            : `Unpaid ${m.daysSincePayment}d`}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <ActionBtn icon={Phone} label="Mark contacted" disabled={isBusy}
          onClick={() => onAction(m.contactId, 'contacted')} />
        <ActionBtn icon={ClipboardList} label="Assign task" disabled={isBusy}
          onClick={() => onAction(m.contactId, 'task_assigned')} />
      </div>
    </div>
  )
}
