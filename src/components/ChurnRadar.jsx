'use client'

// CHURN-RADAR.1 — the at-risk member radar dashboard.
//
// Tabs:
//   At Risk       — scored active members + per-member win-back actions.
//   Win-back      — former members (lapsed 45–365 days) worth re-winning.
//   Overdue       — members whose MEMBERSHIP payment failed (a past-due
//                   subscription renewal / first payment); the chase-list.
//   Unpaid charges— every other confirmed past-due charge (fees, custom
//                   charges, class bookings, class packs, products), any amount.
//   Awaiting auth — PENDING charges Glofox hasn't collected yet (AWAITING-AUTH.1).
//   Quarantine    — zero-activity "ghost member" records for bulk triage.
//
// All data comes from /api/churn-radar/*; this component is pure UI +
// fetch orchestration.

import { useEffect, useState, useCallback } from 'react'
import {
  Radar, AlertTriangle, Clock, TrendingDown, UserX, Phone,
  ClipboardList, BellOff, Check, CalendarClock, RotateCcw,
  CreditCard, Ticket, TrendingUp, Mail, UserMinus, Coins, Hourglass,
} from 'lucide-react'
import RadarOutreachButton from '@/components/RadarOutreachButton'

const TIER_STYLE = {
  high:   { label: 'High',   cls: 'bg-red-100 text-red-700' },
  medium: { label: 'Medium', cls: 'bg-amber-100 text-amber-700' },
  low:    { label: 'Low',    cls: 'bg-un1t-border text-un1t-subtle' },
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
  const [charges, setCharges] = useState(null)
  const [awaiting, setAwaiting] = useState(null)
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

  const loadCharges = useCallback(async () => {
    try {
      const r = await fetch('/api/churn-radar/unpaid-charges', { cache: 'no-store' })
      const j = await r.json()
      if (!r.ok || !j.success) throw new Error(j.error || 'Failed to load unpaid charges')
      setCharges(j.data)
    } catch (e) {
      setError(e.message)
    }
  }, [])

  const loadAwaiting = useCallback(async () => {
    try {
      const r = await fetch('/api/churn-radar/awaiting-authorization', { cache: 'no-store' })
      const j = await r.json()
      if (!r.ok || !j.success) throw new Error(j.error || 'Failed to load awaiting authorization')
      setAwaiting(j.data)
    } catch (e) {
      setError(e.message)
    }
  }, [])

  useEffect(() => { loadRadar() }, [loadRadar])
  useEffect(() => {
    if (tab === 'quarantine' && quarantine === null) loadQuarantine()
    if (tab === 'winback' && winback === null) loadWinback()
    if (tab === 'overdue' && overdue === null) loadOverdue()
    if (tab === 'charges' && charges === null) loadCharges()
    if (tab === 'awaiting' && awaiting === null) loadAwaiting()
  }, [tab, quarantine, winback, overdue, charges, awaiting, loadQuarantine, loadWinback, loadOverdue, loadCharges, loadAwaiting])

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
      if (charges !== null) await loadCharges()
      if (awaiting !== null) await loadAwaiting()
    } catch (e) {
      showFlash(e.message, false)
    } finally {
      setBusy(null)
    }
  }

  // RADAR-PAY.2 — re-pull one member straight from Glofox, then reload
  // the lists so a now-resolved account drops off the column (and can't
  // be dunned). Reuses the per-row `busy` lock so its spinner shows.
  async function runRefresh(contactId) {
    setBusy(contactId)
    try {
      const r = await fetch('/api/churn-radar/refresh-member', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contact_id: contactId }),
      })
      const j = await r.json()
      if (!r.ok || !j.success) throw new Error(j.error || 'Refresh failed')
      showFlash(
        j.data.still_flagged
          ? 'Re-pulled from Glofox — still behind on payment.'
          : 'Re-pulled from Glofox — account is clear, removing from the list.',
      )
      await loadRadar()
      if (winback !== null) await loadWinback()
      if (overdue !== null) await loadOverdue()
      if (charges !== null) await loadCharges()
      if (awaiting !== null) await loadAwaiting()
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

  if (loading) return <p className="text-sm text-un1t-subtle">Loading radar…</p>

  const summary = radar?.summary || {
    activeBase: 0, atRisk: 0, highRisk: 0, quarantine: 0, paused: 0, overdue: 0,
    snoozed: 0, revenueAtRiskCents: 0, overdueValueCents: 0,
    recovery: { contacted: 0, recovered: 0, recoveryRate: 0 },
    trend: null,
    bySegment: { member: {}, credit: {} },
  }
  const seg = summary.bySegment || { member: {}, credit: {} }
  const splitLine = (key) =>
    `${seg.member?.[key] || 0} members · ${seg.credit?.[key] || 0} packs`
  // RADAR-TREND.1 — week-over-week deltas, null until the first
  // weekly snapshot exists.
  const td = summary.trend?.deltas || null

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
        <StatCard label="Active base" value={summary.activeBase} breakdown={splitLine('activeBase')}
          delta={td?.activeBase} deltaGoodDir="up" />
        <StatCard label="At risk" value={summary.atRisk} accent="amber" breakdown={splitLine('atRisk')}
          delta={td?.atRisk} deltaGoodDir="down" />
        <StatCard label="Revenue at risk" value={formatMoney(summary.revenueAtRiskCents)} accent="amber" breakdown="per month, at-risk"
          delta={td?.revenueAtRiskCents} deltaGoodDir="down" deltaIsMoney />
        <StatCard label="High risk" value={summary.highRisk} accent="red"
          delta={td?.highRisk} deltaGoodDir="down" />
        <StatCard label="Overdue" value={summary.overdue} accent="red" breakdown={`${formatMoney(summary.overdueValueCents)} owed`}
          delta={td?.overdue} deltaGoodDir="down" />
        <StatCard label="Paused" value={summary.paused} breakdown="planned freeze"
          delta={td?.paused} />
        <StatCard label="Quarantine" value={summary.quarantine}
          delta={td?.quarantine} deltaGoodDir="down" />
      </div>

      {/* RADAR-OUTCOMES.1 — closes the loop: of everyone the operator
          reached out to, how many actually came back to training. */}
      {summary.recovery?.contacted > 0 && (
        <div className="mb-6 flex items-center gap-2 rounded-xl border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">
          <TrendingUp size={16} className="shrink-0" />
          <span>
            <strong>{summary.recovery.recovered} of {summary.recovery.contacted}</strong>
            {' '}members contacted in the last 90 days came back training
            {' '}<strong>({Math.round(summary.recovery.recoveryRate * 100)}%)</strong>.
          </span>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-un1t-border mb-4">
        <Tab active={tab === 'radar'} onClick={() => setTab('radar')}
          icon={Radar} label={`At Risk (${radar?.radar?.length || 0})`} />
        <Tab active={tab === 'winback'} onClick={() => setTab('winback')}
          icon={RotateCcw} label={`Win-back${winback ? ` (${winback.winback.length})` : ''}`} />
        <Tab active={tab === 'overdue'} onClick={() => setTab('overdue')}
          icon={CreditCard} label={`Overdue (${summary.overdue})`} />
        <Tab active={tab === 'charges'} onClick={() => setTab('charges')}
          icon={Coins} label={`Unpaid charges (${summary.unpaidCharges || 0})`} />
        <Tab active={tab === 'awaiting'} onClick={() => setTab('awaiting')}
          icon={Hourglass} label={`Awaiting authorization (${summary.awaitingAuth || 0})`} />
        <Tab active={tab === 'quarantine'} onClick={() => setTab('quarantine')}
          icon={AlertTriangle}
          label={`Quarantine (${quarantine ? quarantine.length : summary.quarantine})`} />
      </div>

      {tab === 'radar' && (
        <RadarList radar={radar?.radar || []} busy={busy} onAction={runAction}
          onRefresh={runRefresh} snoozed={summary.snoozed} />
      )}

      {tab === 'winback' && (
        <WinbackList data={winback} busy={busy} onAction={runAction} />
      )}

      {tab === 'overdue' && (
        <OverdueList data={overdue} busy={busy} onAction={runAction} onRefresh={runRefresh} />
      )}

      {tab === 'charges' && (
        <UnpaidChargesList data={charges} busy={busy} onAction={runAction} onRefresh={runRefresh} />
      )}

      {tab === 'awaiting' && (
        <AwaitingAuthList data={awaiting} busy={busy} onAction={runAction} onRefresh={runRefresh} />
      )}

      {tab === 'quarantine' && (
        <Quarantine items={quarantine} selected={selected} busy={busy}
          onToggle={toggleSelect} onSelectAll={(all) => setSelected(all ? new Set((quarantine || []).map((q) => q.contactId)) : new Set())}
          onTriage={runQuarantine} />
      )}

      <DigestSettings />
      <DunningSettings />
    </div>
  )
}

// RADAR-DIGEST.1 — recipient editor for the weekly email digest.
// Reads / writes locations.churn_digest_recipients via the
// digest-settings API. Empty list = digest off.
function DigestSettings() {
  const [text, setText] = useState(null)   // null = still loading
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch('/api/churn-radar/digest-settings', { cache: 'no-store' })
        const j = await r.json()
        if (!r.ok || !j.success) throw new Error(j.error || 'Failed to load digest settings')
        if (!cancelled) setText((j.data.recipients || []).join('\n'))
      } catch (e) {
        if (!cancelled) { setErr(e.message); setText('') }
      }
    })()
    return () => { cancelled = true }
  }, [])

  async function save() {
    setSaving(true); setErr(null); setSaved(false)
    try {
      const recipients = text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
      const r = await fetch('/api/churn-radar/digest-settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recipients }),
      })
      const j = await r.json()
      if (!r.ok || !j.success) throw new Error(j.error || 'Save failed')
      setText((j.data.recipients || []).join('\n'))
      setSaved(true)
      setTimeout(() => setSaved(false), 4000)
    } catch (e) {
      setErr(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-8 rounded-xl border border-un1t-border bg-un1t-surface p-4">
      <div className="flex items-center gap-2">
        <Mail size={15} className="text-un1t-subtle" />
        <h3 className="text-sm font-medium text-un1t-text">Weekly email digest</h3>
      </div>
      <p className="mt-1 text-xs text-un1t-subtle">
        Who receives the Monday churn-radar summary — current numbers, the
        week-over-week change, and the recent-weeks trend. One email address per
        line. Leave blank to turn the digest off.
      </p>
      {text === null ? (
        <p className="mt-3 text-sm text-un1t-subtle">Loading…</p>
      ) : (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            placeholder="owner@un1t.ie"
            className="mt-3 w-full rounded-lg border border-un1t-border bg-un1t-bg p-2 text-sm text-un1t-text"
          />
          <div className="mt-2 flex items-center gap-3">
            <button type="button" onClick={save} disabled={saving}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
              {saving ? 'Saving…' : 'Save recipients'}
            </button>
            {saved && <span className="text-xs text-green-600">Saved.</span>}
            {err && <span className="text-xs text-red-600">{err}</span>}
          </div>
        </>
      )}
    </div>
  )
}

// RADAR-PAY.1 / DUNNING.5 — the payment-reminders automation: which
// sequence the one-click "Send payment reminder" (and, when switched on,
// a failed membership payment) enrols members into. Reads / writes
// locations.dunning_sequence_id + dunning_auto_enroll via dunning-settings.
function DunningSettings() {
  const [state, setState] = useState(null)   // null = loading
  const [sel, setSel] = useState('')
  const [auto, setAuto] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch('/api/churn-radar/dunning-settings', { cache: 'no-store' })
        const j = await r.json()
        if (!r.ok || !j.success) throw new Error(j.error || 'Failed to load dunning settings')
        if (!cancelled) {
          setState(j.data)
          setSel(j.data.dunning_sequence_id || '')
          setAuto(!!j.data.dunning_auto_enroll)
        }
      } catch (e) {
        if (!cancelled) { setErr(e.message); setState({ sequences: [] }) }
      }
    })()
    return () => { cancelled = true }
  }, [])

  async function save() {
    setSaving(true); setErr(null); setSaved(false)
    try {
      const r = await fetch('/api/churn-radar/dunning-settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dunning_sequence_id: sel || null, dunning_auto_enroll: sel ? auto : false }),
      })
      const j = await r.json()
      if (!r.ok || !j.success) throw new Error(j.error || 'Save failed')
      setSaved(true)
      setTimeout(() => setSaved(false), 4000)
    } catch (e) {
      setErr(e.message)
    } finally {
      setSaving(false)
    }
  }

  const sequences = state?.sequences || []
  const chosen = sequences.find((s) => s.id === sel)

  return (
    <div className="mt-4 rounded-xl border border-un1t-border bg-un1t-surface p-4">
      <div className="flex items-center gap-2">
        <CreditCard size={15} className="text-un1t-subtle" />
        <h3 className="text-sm font-medium text-un1t-text">Payment reminders</h3>
      </div>
      <p className="mt-1 text-xs text-un1t-subtle">
        The automation that reminds a member to update their card when a{' '}
        <span className="font-medium">membership payment fails</span>. Install
        &ldquo;Overdue membership payment &rarr; card update reminders&rdquo; from the
        automations templates (or build a manual one), pick it here, and choose
        whether it starts by itself. The one-click{' '}
        <span className="font-medium">Send payment reminder</span> on the Overdue tab
        uses the same automation. Leave unset to hide the button.
      </p>
      {state === null ? (
        <p className="mt-3 text-sm text-un1t-subtle">Loading…</p>
      ) : sequences.length === 0 ? (
        <p className="mt-3 text-xs text-amber-600">
          No manual automations yet. Install the card-update reminders template under
          Automations &rarr; Templates (or build one with a manual trigger), then come
          back to pick it here.
        </p>
      ) : (
        <>
          <select
            value={sel}
            onChange={(e) => setSel(e.target.value)}
            className="mt-3 w-full rounded-lg border border-un1t-border bg-un1t-bg p-2 text-sm text-un1t-text"
          >
            <option value="">— None (dunning button hidden) —</option>
            {sequences.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}{s.status === 'active' ? '' : ' (paused)'}
              </option>
            ))}
          </select>
          {chosen && chosen.status !== 'active' && (
            <p className="mt-2 text-xs text-amber-600">
              This sequence is paused — activate it under Sequences or reminders won&apos;t send.
            </p>
          )}
          <label className={`mt-3 flex items-start gap-2 text-xs ${sel ? 'text-un1t-text' : 'text-un1t-subtle'}`}>
            <input type="checkbox" className="mt-0.5" checked={!!sel && auto} disabled={!sel}
              onChange={(e) => setAuto(e.target.checked)} />
            <span>
              <span className="font-medium">Start reminders automatically</span> when a membership
              payment fails. Fees, class packs and custom charges never trigger it; the run stops
              the moment the membership payment is paid or written off, or the membership pauses.
            </span>
          </label>
          <div className="mt-2 flex items-center gap-3">
            <button type="button" onClick={save} disabled={saving}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
              {saving ? 'Saving…' : 'Save payment reminders'}
            </button>
            {saved && <span className="text-xs text-green-600">Saved.</span>}
            {err && <span className="text-xs text-red-600">{err}</span>}
          </div>
        </>
      )}
    </div>
  )
}

const ACTION_DONE = {
  contacted: 'Logged as contacted',
  task_assigned: 'Follow-up task created',
  winback_sent: 'Win-back message sent',
  outreach_sent: 'WhatsApp template sent',
  payment_reminder: 'Enrolled in dunning sequence',
  snoozed: 'Snoozed for 14 days',
  dismissed: 'Reclassified as not a member — removed from the radar',
}

// CHURN-CLEAN.1 — durable "Not a member" reclassify. A confirm guards
// it because it permanently drops the member from every radar list +
// the active-base count (the operator backstop for a trial / one-off
// the upstream classifier didn't catch).
function confirmDismiss(name, onAction, contactId) {
  if (typeof window !== 'undefined' && !window.confirm(
    `Reclassify ${name || 'this member'} as "not a paying member"?\n\n` +
    'They drop off every churn-radar list and stop counting toward the active base. ' +
    'Use this for leads, trials, and one-off class packs that slipped onto the list.',
  )) return
  onAction(contactId, 'dismissed')
}

// ── small pieces ─────────────────────────────────────────────────

function StatCard({ label, value, accent, breakdown, delta, deltaGoodDir, deltaIsMoney }) {
  const valueCls = accent === 'red' ? 'text-red-600'
    : accent === 'amber' ? 'text-amber-600' : 'text-un1t-text'
  return (
    <div className="rounded-xl border border-un1t-border bg-white p-4">
      <p className="text-xs text-un1t-subtle">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${valueCls}`}>{value}</p>
      {breakdown && <p className="mt-0.5 text-[11px] text-un1t-muted">{breakdown}</p>}
      <TrendDelta delta={delta} goodDir={deltaGoodDir} money={deltaIsMoney} />
    </div>
  )
}

// RADAR-TREND.1 — week-over-week delta line under a stat value.
// Coloured good / bad when a direction is given (e.g. a falling
// at-risk count is good); muted for no-change or no-direction.
function TrendDelta({ delta, goodDir, money }) {
  if (!Number.isFinite(delta)) return null  // no snapshot to compare yet
  if (delta === 0) {
    return <p className="mt-0.5 text-[11px] text-un1t-muted">— no change vs last week</p>
  }
  const up = delta > 0
  let cls = 'text-un1t-muted'
  if (goodDir === 'up') cls = up ? 'text-green-600' : 'text-red-600'
  else if (goodDir === 'down') cls = up ? 'text-red-600' : 'text-green-600'
  const mag = money ? formatMoney(Math.abs(delta)) : Math.abs(delta)
  return (
    <p className={`mt-0.5 text-[11px] font-medium ${cls}`}>
      {up ? '▲' : '▼'} {mag} vs last week
    </p>
  )
}

function Tab({ active, onClick, icon: Icon, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px ${
        active
          ? 'border-un1t-text text-un1t-text'
          : 'border-transparent text-un1t-subtle hover:text-un1t-text'
      }`}
    >
      <Icon size={15} />
      {label}
    </button>
  )
}

function RadarList({ radar, busy, onAction, onRefresh, snoozed }) {
  if (radar.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-un1t-border p-10 text-center">
        <Radar size={28} className="mx-auto text-un1t-subtle" />
        <p className="mt-3 font-medium text-un1t-text">Nobody at risk right now</p>
        <p className="mt-1 text-sm text-un1t-subtle">
          Every active member is attending normally. The radar refreshes nightly.
        </p>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      {snoozed > 0 && (
        <p className="text-xs text-un1t-muted">{snoozed} member{snoozed === 1 ? '' : 's'} snoozed and hidden.</p>
      )}
      {radar.map((m) => <RadarRow key={m.contactId} m={m} busy={busy} onAction={onAction} onRefresh={onRefresh} />)}
    </div>
  )
}

function RadarRow({ m, busy, onAction, onRefresh }) {
  const tier = TIER_STYLE[m.tier] || TIER_STYLE.low
  const isBusy = busy === m.contactId
  return (
    <div className="rounded-lg border border-un1t-border bg-un1t-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <a href={`/contacts/${m.contactId}`} className="font-medium text-un1t-text hover:underline">
              {m.name}
            </a>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${tier.cls}`}>
              {tier.label} · {m.score}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-un1t-subtle">
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
        <RadarOutreachButton contactName={m.name} disabled={isBusy} busy={isBusy}
          onSelect={(tpl) => onAction(m.contactId, 'outreach_sent', { template_name: tpl })} />
        {m.signals.some((s) => s.key === 'payment_slipping') && (
          <ActionBtn icon={CreditCard} label="Send payment reminder" disabled={isBusy} primary
            onClick={() => onAction(m.contactId, 'payment_reminder')} />
        )}
        {onRefresh && (
          <ActionBtn icon={RotateCcw} label="Refresh from Glofox" disabled={isBusy}
            title="Re-pull this member's Glofox status now"
            onClick={() => onRefresh(m.contactId)} />
        )}
        <ActionBtn icon={BellOff} label="Snooze" disabled={isBusy}
          onClick={() => onAction(m.contactId, 'snoozed')} />
        <ActionBtn icon={UserMinus} label="Not a member" disabled={isBusy}
          title="Reclassify as not a paying member — removes them from the radar for good"
          onClick={() => confirmDismiss(m.name, onAction, m.contactId)} />
      </div>
    </div>
  )
}

function ActionBtn({ icon: Icon, label, onClick, disabled, primary, title }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${
        primary
          ? 'bg-indigo-600 text-white hover:bg-indigo-500'
          : 'border border-un1t-border bg-un1t-bg text-un1t-subtle hover:text-un1t-text'
      }`}
    >
      <Icon size={13} />
      {label}
    </button>
  )
}

function Quarantine({ items, selected, busy, onToggle, onSelectAll, onTriage }) {
  if (items === null) return <p className="text-sm text-un1t-subtle">Loading quarantine…</p>
  if (items.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-un1t-border p-10 text-center">
        <Check size={28} className="mx-auto text-green-500" />
        <p className="mt-3 font-medium text-un1t-text">Quarantine is clear</p>
        <p className="mt-1 text-sm text-un1t-subtle">Every member has activity data or has been triaged.</p>
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
        <label className="inline-flex items-center gap-2 text-xs text-un1t-subtle">
          <input type="checkbox" checked={allSelected} onChange={(e) => onSelectAll(e.target.checked)} />
          Select all ({items.length})
        </label>
        {selected.size > 0 && (
          <div className="flex gap-2">
            <button type="button" disabled={isBusy} onClick={() => onTriage('keep')}
              className="rounded-md border border-un1t-border bg-un1t-bg px-2.5 py-1 text-xs font-medium text-un1t-subtle hover:text-un1t-text disabled:opacity-50">
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
            className="flex items-center gap-3 rounded-lg border border-un1t-border bg-un1t-surface p-3">
            <input type="checkbox" checked={selected.has(q.contactId)} onChange={() => onToggle(q.contactId)} />
            <div className="min-w-0 flex-1">
              <a href={`/contacts/${q.contactId}`} className="text-sm font-medium text-un1t-text hover:underline">
                {q.name}
              </a>
              <p className="text-xs text-un1t-subtle">
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
  if (data === null) return <p className="text-sm text-un1t-subtle">Loading win-back…</p>
  const rows = data.winback || []
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-un1t-border p-10 text-center">
        <RotateCcw size={28} className="mx-auto text-un1t-subtle" />
        <p className="mt-3 font-medium text-un1t-text">No win-back candidates</p>
        <p className="mt-1 text-sm text-un1t-subtle">
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
        <p className="text-xs text-un1t-muted">{data.summary.snoozed} snoozed and hidden.</p>
      )}
      {rows.map((m) => <WinbackRow key={m.contactId} m={m} busy={busy} onAction={onAction} />)}
    </div>
  )
}

function WinbackRow({ m, busy, onAction }) {
  const tier = TIER_STYLE[m.tier] || TIER_STYLE.low
  const isBusy = busy === m.contactId
  return (
    <div className="rounded-lg border border-un1t-border bg-un1t-surface p-4">
      <div className="flex items-center gap-2">
        <a href={`/contacts/${m.contactId}`} className="font-medium text-un1t-text hover:underline">
          {m.name}
        </a>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${tier.cls}`}>
          {tier.label}
        </span>
      </div>
      <p className="mt-0.5 text-xs text-un1t-subtle">
        {m.membershipPlan || m.status?.replace(/_/g, ' ')}
        {` · last class ${m.daysSinceAttended}d ago`}
        {m.monthlyValueCents > 0 && ` · ${formatMoney(m.monthlyValueCents)}/mo`}
        {m.lifetimeValueCents > 0 && ` · ${formatMoney(m.lifetimeValueCents)} LTV`}
        {m.lastContacted && ` · contacted ${timeAgo(m.lastContacted.at)}`}
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <ActionBtn icon={Phone} label="Mark contacted" disabled={isBusy}
          onClick={() => onAction(m.contactId, 'contacted')} />
        <RadarOutreachButton contactName={m.name} disabled={isBusy} busy={isBusy}
          onSelect={(tpl) => onAction(m.contactId, 'outreach_sent', { template_name: tpl })} />
        <ActionBtn icon={BellOff} label="Snooze" disabled={isBusy}
          onClick={() => onAction(m.contactId, 'snoozed')} />
        <ActionBtn icon={UserMinus} label="Not a member" disabled={isBusy}
          title="Reclassify as not a paying member — removes them from the radar for good"
          onClick={() => confirmDismiss(m.name, onAction, m.contactId)} />
      </div>
    </div>
  )
}

// ── overdue ──────────────────────────────────────────────────────

function OverdueList({ data, busy, onAction, onRefresh }) {
  if (data === null) return <p className="text-sm text-un1t-subtle">Loading overdue…</p>
  const rows = data.overdue || []
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-un1t-border p-10 text-center">
        <Check size={28} className="mx-auto text-green-500" />
        <p className="mt-3 font-medium text-un1t-text">No failed membership payments</p>
        <p className="mt-1 text-sm text-un1t-subtle">
          No member has a past-due membership renewal or first payment. Other
          unpaid items (fees, class packs, bookings, products) are under the{' '}
          <strong>Unpaid charges</strong> tab.
        </p>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      <p className="mb-1 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800">
        Members whose <strong>membership payment failed</strong> — a subscription
        renewal or first payment Glofox could not collect. The amount owed is the
        sum of their open past-due membership invoices, highest first; open a
        profile for their contact details. Fees, class packs, bookings and
        products are under <strong>Unpaid charges</strong>.
      </p>
      {rows.map((m) => <OverdueRow key={m.contactId} m={m} busy={busy} onAction={onAction} onRefresh={onRefresh} />)}
    </div>
  )
}

// ARREARS-TYPE.1 — every confirmed past-due charge that is NOT a membership
// payment: fees, custom charges, class bookings, class packs, products — any
// amount. Same row shape as Overdue, so it reuses OverdueRow; only the framing
// differs. PENDING 'awaiting authorization' charges are NOT here — own tab.
// DUNNING.4 — no card-update reminder button here: these aren't membership
// payments, and the reminder copy says "membership payment".
function UnpaidChargesList({ data, busy, onAction, onRefresh }) {
  if (data === null) return <p className="text-sm text-un1t-subtle">Loading unpaid charges…</p>
  const rows = data.charges || []
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-un1t-border p-10 text-center">
        <Check size={28} className="mx-auto text-green-500" />
        <p className="mt-3 font-medium text-un1t-text">No unpaid charges</p>
        <p className="mt-1 text-sm text-un1t-subtle">
          No member has a failed one-off charge. Failed membership payments are
          under the <strong>Overdue</strong> tab; charges still awaiting payment
          are under <strong>Awaiting authorization</strong>.
        </p>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      <p className="mb-1 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
        <strong>Failed one-off charges</strong> — late-cancel and no-show fees,
        custom charges, class bookings, class packs and products, at any amount.
        Not membership debts (those are under <strong>Overdue</strong>), but
        worth clearing. Charges not yet collected are under <strong>Awaiting
        authorization</strong>. Highest owed first.
      </p>
      {rows.map((m) => <OverdueRow key={m.contactId} m={m} busy={busy} onAction={onAction} onRefresh={onRefresh} canRemind={false} />)}
    </div>
  )
}

// AWAITING-AUTH.1 — PENDING custom-charge fees Glofox shows as "Awaiting
// authorization": a no-show / late-cancel fee applied but not yet collected. Not
// a confirmed debt, so it's kept off Overdue and out of Unpaid charges. Reuses
// OverdueRow with the 'awaiting' variant (amber pill, "awaiting authorization").
function AwaitingAuthList({ data, busy, onAction, onRefresh }) {
  if (data === null) return <p className="text-sm text-un1t-subtle">Loading awaiting authorization…</p>
  const rows = data.charges || []
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-un1t-border p-10 text-center">
        <Check size={28} className="mx-auto text-green-500" />
        <p className="mt-3 font-medium text-un1t-text">Nothing awaiting authorization</p>
        <p className="mt-1 text-sm text-un1t-subtle">
          No member has a pending charge waiting to be collected. Confirmed
          past-due items are under the <strong>Overdue</strong> (membership
          payments) and <strong>Unpaid charges</strong> (everything else) tabs.
        </p>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      <p className="mb-1 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
        <strong>Pending charges awaiting authorization</strong> — no-show or
        late-cancel fees Glofox has applied but not yet collected. Not confirmed
        debts yet; they clear once the member&apos;s payment goes through. Highest first.
      </p>
      {rows.map((m) => <OverdueRow key={m.contactId} m={m} busy={busy} onAction={onAction} onRefresh={onRefresh} variant="awaiting" canRemind={false} />)}
    </div>
  )
}

function OverdueRow({ m, busy, onAction, onRefresh, variant = 'owed', canRemind = true }) {
  const isBusy = busy === m.contactId
  const awaiting = variant === 'awaiting'
  const attendLine = m.daysSinceAttended == null
    ? 'no class history'
    : m.daysSinceAttended <= 30
      ? `still training — last class ${m.daysSinceAttended}d ago`
      : `last class ${m.daysSinceAttended}d ago`
  const PillIcon = awaiting ? Clock : CreditCard
  return (
    <div className="rounded-lg border border-un1t-border bg-un1t-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <a href={`/contacts/${m.contactId}`} className="font-medium text-un1t-text hover:underline">
              {m.name}
            </a>
            <span className="rounded-full bg-un1t-border px-2 py-0.5 text-[10px] font-semibold uppercase text-un1t-subtle">
              {m.segment === 'credit' ? 'Pack' : 'Member'}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-un1t-subtle">
            {m.membershipPlan || m.membershipStatus}
            {m.invoiceCount > 1 && ` · ${m.invoiceCount} ${awaiting ? 'pending charges' : 'unpaid invoices'}`}
            {` · ${attendLine}`}
            {m.lastContacted && ` · contacted ${timeAgo(m.lastContacted.at)}`}
          </p>
        </div>
        <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium ${
          awaiting ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-red-200 bg-red-50 text-red-700'
        }`}>
          <PillIcon size={12} />
          {formatMoney(m.amountOwedCents)}{awaiting ? ' awaiting authorization' : ' owed'}
          {m.daysOverdue != null && (awaiting ? ` · applied ${m.daysOverdue}d ago` : ` · ${m.daysOverdue}d overdue`)}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <ActionBtn icon={Phone} label="Mark contacted" disabled={isBusy}
          onClick={() => onAction(m.contactId, 'contacted')} />
        <ActionBtn icon={ClipboardList} label="Assign task" disabled={isBusy}
          onClick={() => onAction(m.contactId, 'task_assigned')} />
        {/* DUNNING.4 — the card-update reminder is for a failed MEMBERSHIP
            payment; the Unpaid-charges / Awaiting tabs pass canRemind={false}. */}
        {canRemind && (
          <ActionBtn icon={CreditCard} label="Send payment reminder" disabled={isBusy} primary
            onClick={() => onAction(m.contactId, 'payment_reminder')} />
        )}
        <RadarOutreachButton contactName={m.name} disabled={isBusy} busy={isBusy}
          onSelect={(tpl) => onAction(m.contactId, 'outreach_sent', { template_name: tpl })} />
        {onRefresh && (
          <ActionBtn icon={RotateCcw} label="Refresh from Glofox" disabled={isBusy}
            title="Re-pull this member's Glofox status now — clears them if they've paid"
            onClick={() => onRefresh(m.contactId)} />
        )}
        <ActionBtn icon={UserMinus} label="Not a member" disabled={isBusy}
          title="Reclassify as not a paying member — removes them from the radar for good"
          onClick={() => confirmDismiss(m.name, onAction, m.contactId)} />
      </div>
    </div>
  )
}
