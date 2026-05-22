'use client'

// LEAD-RADAR.1 — the non-member triage radar dashboard.
//
// Three tabs:
//   Funnel    — the live non-member cohort worth chasing to convert,
//               scored (trial attending > re-engaged > fresh), with
//               per-contact "contacted" / "snooze" actions.
//   ClassPass — read-only list of ClassPass drop-ins (LEAD-CLASSPASS.1).
//               They rarely convert to a direct membership, so they
//               sit out of the funnel — shown for awareness only.
//   Cleanup   — the dormant lead/trial records, bucket-filterable, for
//               bulk archive / keep triage.
//
// All data comes from /api/lead-radar/*; this component is pure UI +
// fetch orchestration.

import { useEffect, useState, useCallback } from 'react'
import {
  Radar, CreditCard, Clock, Activity, Sparkles, Phone, BellOff,
  Check, Filter, Users, TrendingUp,
} from 'lucide-react'

const TIER_STYLE = {
  high:   { label: 'High',   cls: 'bg-red-100 text-red-700' },
  medium: { label: 'Medium', cls: 'bg-amber-100 text-amber-700' },
  low:    { label: 'Low',    cls: 'bg-un1t-gray text-un1t-light' },
}

const SIGNAL_ICON = {
  trial_convert: Clock,
  reengaged: Activity,
  fresh_signup: Sparkles,
}

const CLEANUP_BUCKETS = [
  { key: 'all',     label: 'All' },
  { key: 'cooling', label: 'Cooling' },
  { key: 'dormant', label: 'Dormant' },
  { key: 'no_sale', label: 'No-sale' },
]

// LEAD-CLASSPASS.1 — filters for the read-only ClassPass tab.
const CLASSPASS_FILTERS = [
  { key: 'all',       label: 'All' },
  { key: 'attending', label: 'Attending' },
  { key: 'lapsed',    label: 'Lapsed' },
]

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

export default function LeadRadar() {
  const [tab, setTab] = useState('funnel')
  const [funnel, setFunnel] = useState(null)
  const [cleanup, setCleanup] = useState(null)
  const [cleanupBucket, setCleanupBucket] = useState('all')
  const [classpass, setClasspass] = useState(null)
  const [classpassFilter, setClasspassFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)
  const [flash, setFlash] = useState(null)
  const [selected, setSelected] = useState(() => new Set())

  const loadFunnel = useCallback(async () => {
    setError(null)
    try {
      const r = await fetch('/api/lead-radar', { cache: 'no-store' })
      const j = await r.json()
      if (!r.ok || !j.success) throw new Error(j.error || 'Failed to load funnel')
      setFunnel(j.data)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadCleanup = useCallback(async (bucket) => {
    try {
      const qs = bucket && bucket !== 'all' ? `?bucket=${bucket}` : ''
      const r = await fetch(`/api/lead-radar/cleanup${qs}`, { cache: 'no-store' })
      const j = await r.json()
      if (!r.ok || !j.success) throw new Error(j.error || 'Failed to load cleanup')
      setCleanup(j.data)
    } catch (e) {
      setError(e.message)
    }
  }, [])

  const loadClassPassList = useCallback(async (filter) => {
    try {
      const qs = filter && filter !== 'all' ? `?filter=${filter}` : ''
      const r = await fetch(`/api/lead-radar/classpass${qs}`, { cache: 'no-store' })
      const j = await r.json()
      if (!r.ok || !j.success) throw new Error(j.error || 'Failed to load ClassPass')
      setClasspass(j.data)
    } catch (e) {
      setError(e.message)
    }
  }, [])

  useEffect(() => { loadFunnel() }, [loadFunnel])
  useEffect(() => {
    if (tab === 'cleanup') { setSelected(new Set()); loadCleanup(cleanupBucket) }
  }, [tab, cleanupBucket, loadCleanup])
  useEffect(() => {
    if (tab === 'classpass') loadClassPassList(classpassFilter)
  }, [tab, classpassFilter, loadClassPassList])

  function showFlash(msg, ok = true) {
    setFlash({ msg, ok })
    setTimeout(() => setFlash(null), 5000)
  }

  async function runAction(contactId, action) {
    setBusy(contactId)
    try {
      const r = await fetch('/api/lead-radar/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contact_id: contactId, action }),
      })
      const j = await r.json()
      if (!r.ok || !j.success) throw new Error(j.error || 'Action failed')
      showFlash(action === 'snoozed' ? 'Snoozed for 30 days' : 'Logged as contacted')
      await loadFunnel()
    } catch (e) {
      showFlash(e.message, false)
    } finally {
      setBusy(null)
    }
  }

  async function runCleanup(decision) {
    const ids = [...selected]
    if (ids.length === 0) return
    setBusy('cleanup')
    try {
      const r = await fetch('/api/lead-radar/cleanup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contact_ids: ids, decision }),
      })
      const j = await r.json()
      if (!r.ok || !j.success) throw new Error(j.error || 'Triage failed')
      showFlash(`${j.data.triaged} record${j.data.triaged === 1 ? '' : 's'} ${decision === 'archive' ? 'archived' : 'kept'}`)
      setSelected(new Set())
      await loadCleanup(cleanupBucket)
      await loadFunnel()  // summary counts changed
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

  const summary = funnel?.summary || {
    funnelTotal: 0, funnel: { attending: 0, fresh: 0 },
    cleanupTotal: 0, cleanup: { cooling: 0, dormant: 0, no_sale: 0 }, snoozed: 0,
    classpassTotal: 0, classpass: { attending: 0, lapsed: 0 },
    conversion: { contacted: 0, progressed: 0, progressionRate: 0 },
    trend: null,
  }
  // LEAD-TREND.1 — week-over-week deltas, null until the first
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

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5 mb-6">
        <StatCard label="Funnel" value={summary.funnelTotal} accent="green"
          breakdown="live — worth a follow-up" delta={td?.funnelTotal} />
        <StatCard label="Attending" value={summary.funnel?.attending || 0}
          breakdown="recent class activity" delta={td?.attending} deltaGoodDir="up" />
        <StatCard label="Fresh" value={summary.funnel?.fresh || 0}
          breakdown="joined recently, no visit" delta={td?.fresh} deltaGoodDir="up" />
        <StatCard label="ClassPass" value={summary.classpassTotal}
          breakdown={`${summary.classpass?.attending || 0} attending recently`} />
        <StatCard label="Cleanup" value={summary.cleanupTotal} accent="amber"
          breakdown="dormant — archive candidates" delta={td?.cleanupTotal} deltaGoodDir="down" />
      </div>

      {/* LEAD-OUTCOMES.1 — closes the loop: of the leads contacted,
          how many booked or attended a class afterwards. */}
      {summary.conversion?.contacted > 0 && (
        <div className="mb-6 flex items-center gap-2 rounded-xl border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">
          <TrendingUp size={16} className="shrink-0" />
          <span>
            <strong>{summary.conversion.progressed} of {summary.conversion.contacted}</strong>
            {' '}leads contacted in the last 90 days booked or attended a class after
            {' '}<strong>({Math.round(summary.conversion.progressionRate * 100)}%)</strong>.
          </span>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-un1t-gray mb-4">
        <Tab active={tab === 'funnel'} onClick={() => setTab('funnel')}
          icon={Radar} label={`Funnel (${funnel?.funnel?.length || 0})`} />
        <Tab active={tab === 'classpass'} onClick={() => setTab('classpass')}
          icon={CreditCard} label={`ClassPass (${summary.classpassTotal})`} />
        <Tab active={tab === 'cleanup'} onClick={() => setTab('cleanup')}
          icon={Filter} label={`Cleanup (${summary.cleanupTotal})`} />
      </div>

      {tab === 'funnel' && (
        <FunnelList rows={funnel?.funnel || []} busy={busy} onAction={runAction}
          snoozed={summary.snoozed} />
      )}

      {tab === 'classpass' && (
        <ClassPass data={classpass} filter={classpassFilter}
          onFilter={setClasspassFilter} summary={summary} />
      )}

      {tab === 'cleanup' && (
        <Cleanup data={cleanup} bucket={cleanupBucket} onBucket={setCleanupBucket}
          summary={summary} selected={selected} busy={busy} onToggle={toggleSelect}
          onSelectAll={(all) => setSelected(all ? new Set((cleanup?.items || []).map((c) => c.contactId)) : new Set())}
          onTriage={runCleanup} />
      )}
    </div>
  )
}

// ── small pieces ─────────────────────────────────────────────────

function StatCard({ label, value, accent, breakdown, delta, deltaGoodDir }) {
  const valueCls = accent === 'green' ? 'text-green-600'
    : accent === 'amber' ? 'text-amber-600' : 'text-un1t-white'
  return (
    <div className="rounded-xl border border-un1t-gray bg-white p-4">
      <p className="text-xs text-un1t-light">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${valueCls}`}>{value}</p>
      {breakdown && <p className="mt-0.5 text-[11px] text-un1t-mid">{breakdown}</p>}
      <TrendDelta delta={delta} goodDir={deltaGoodDir} />
    </div>
  )
}

// LEAD-TREND.1 — week-over-week delta line under a stat value.
// Coloured good / bad when a direction is given (a growing cleanup
// backlog is bad); muted for no-change or no-direction.
function TrendDelta({ delta, goodDir }) {
  if (!Number.isFinite(delta)) return null  // no snapshot to compare yet
  if (delta === 0) {
    return <p className="mt-0.5 text-[11px] text-un1t-mid">— no change vs last week</p>
  }
  const up = delta > 0
  let cls = 'text-un1t-mid'
  if (goodDir === 'up') cls = up ? 'text-green-600' : 'text-red-600'
  else if (goodDir === 'down') cls = up ? 'text-red-600' : 'text-green-600'
  return (
    <p className={`mt-0.5 text-[11px] font-medium ${cls}`}>
      {up ? '▲' : '▼'} {Math.abs(delta)} vs last week
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
          ? 'border-un1t-white text-un1t-white'
          : 'border-transparent text-un1t-light hover:text-un1t-white'
      }`}
    >
      <Icon size={15} />
      {label}
    </button>
  )
}

function FunnelList({ rows, busy, onAction, snoozed }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-un1t-gray p-10 text-center">
        <Radar size={28} className="mx-auto text-un1t-light" />
        <p className="mt-3 font-medium text-un1t-white">No live prospects right now</p>
        <p className="mt-1 text-sm text-un1t-light">
          No non-members attending or freshly joined. New signups will appear here.
        </p>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      {snoozed > 0 && (
        <p className="text-xs text-un1t-mid">{snoozed} contact{snoozed === 1 ? '' : 's'} snoozed and hidden.</p>
      )}
      {rows.map((r) => <FunnelRow key={r.contactId} r={r} busy={busy} onAction={onAction} />)}
    </div>
  )
}

function FunnelRow({ r, busy, onAction }) {
  const tier = TIER_STYLE[r.tier] || TIER_STYLE.low
  const isBusy = busy === r.contactId
  const Icon = SIGNAL_ICON[r.signal.key] || Activity
  return (
    <div className="rounded-lg border border-un1t-gray bg-un1t-dark p-4">
      <div className="flex items-center gap-2">
        <a href={`/contacts/${r.contactId}`} className="font-medium text-un1t-white hover:underline">
          {r.name}
        </a>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${tier.cls}`}>
          {tier.label}
        </span>
      </div>
      <p className="mt-0.5 text-xs text-un1t-light">
        {r.status?.replace(/_/g, ' ')}
        {r.category === 'attending' && r.daysSinceActivity != null && ` · last class ${r.daysSinceActivity}d ago`}
        {r.category === 'fresh' && r.daysSinceJoined != null && ` · joined ${r.daysSinceJoined}d ago`}
        {r.lastContacted && ` · contacted ${timeAgo(r.lastContacted.at)}`}
      </p>

      {/* Signal chip */}
      <div className="mt-3 flex flex-wrap gap-1.5">
        <span className="inline-flex items-center gap-1 rounded-md border border-green-200 bg-green-50 px-2 py-0.5 text-[11px] text-green-700">
          <Icon size={12} />
          <span className="font-medium">{r.signal.label}</span>
          <span className="opacity-70">· {r.signal.detail}</span>
        </span>
      </div>

      {/* Actions */}
      <div className="mt-3 flex flex-wrap gap-2">
        <ActionBtn icon={Phone} label="Mark contacted" disabled={isBusy}
          onClick={() => onAction(r.contactId, 'contacted')} />
        <ActionBtn icon={BellOff} label="Snooze" disabled={isBusy}
          onClick={() => onAction(r.contactId, 'snoozed')} />
      </div>
    </div>
  )
}

function ActionBtn({ icon: Icon, label, onClick, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1 rounded-md border border-un1t-gray bg-un1t-black px-2.5 py-1 text-xs font-medium text-un1t-light hover:text-un1t-white disabled:opacity-50"
    >
      <Icon size={13} />
      {label}
    </button>
  )
}

function Cleanup({ data, bucket, onBucket, summary, selected, busy, onToggle, onSelectAll, onTriage }) {
  const cleanupCounts = summary.cleanup || { cooling: 0, dormant: 0, no_sale: 0 }
  const countFor = (key) => key === 'all'
    ? summary.cleanupTotal
    : (cleanupCounts[key] || 0)

  return (
    <div>
      <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
        These non-members joined months-to-years ago and have <strong>no class attendance and no bookings</strong>.
        Archiving reclassifies them to <strong>dormant</strong> — out of the active pipeline and campaign
        audiences. It&apos;s reversible and never deletes the record.
      </p>

      {/* Bucket filter */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {CLEANUP_BUCKETS.map((b) => (
          <button
            key={b.key}
            type="button"
            onClick={() => onBucket(b.key)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium ${
              bucket === b.key
                ? 'bg-un1t-white text-un1t-black'
                : 'border border-un1t-gray text-un1t-light hover:text-un1t-white'
            }`}
          >
            {b.label} ({countFor(b.key)})
          </button>
        ))}
      </div>

      {data === null ? (
        <p className="text-sm text-un1t-light">Loading cleanup…</p>
      ) : data.items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-un1t-gray p-10 text-center">
          <Check size={28} className="mx-auto text-green-500" />
          <p className="mt-3 font-medium text-un1t-white">Nothing to triage here</p>
          <p className="mt-1 text-sm text-un1t-light">Every record in this bucket has been triaged.</p>
        </div>
      ) : (
        <CleanupList data={data} selected={selected} busy={busy}
          onToggle={onToggle} onSelectAll={onSelectAll} onTriage={onTriage} />
      )}
    </div>
  )
}

function CleanupList({ data, selected, busy, onToggle, onSelectAll, onTriage }) {
  const items = data.items
  const allSelected = items.length > 0 && selected.size === items.length
  const isBusy = busy === 'cleanup'
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <label className="inline-flex items-center gap-2 text-xs text-un1t-light">
          <input type="checkbox" checked={allSelected} onChange={(e) => onSelectAll(e.target.checked)} />
          Select all shown ({items.length})
          {data.total > items.length && (
            <span className="text-un1t-mid">· {data.total.toLocaleString('en-IE')} total — triage in pages</span>
          )}
        </label>
        {selected.size > 0 && (
          <div className="flex gap-2">
            <button type="button" disabled={isBusy} onClick={() => onTriage('keep')}
              className="rounded-md border border-un1t-gray bg-un1t-black px-2.5 py-1 text-xs font-medium text-un1t-light hover:text-un1t-white disabled:opacity-50">
              Keep {selected.size}
            </button>
            <button type="button" disabled={isBusy} onClick={() => onTriage('archive')}
              className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50">
              Archive {selected.size}
            </button>
          </div>
        )}
      </div>
      <ul className="space-y-1.5">
        {items.map((c) => (
          <li key={c.contactId}
            className="flex items-center gap-3 rounded-lg border border-un1t-gray bg-un1t-dark p-3">
            <input type="checkbox" checked={selected.has(c.contactId)} onChange={() => onToggle(c.contactId)} />
            <div className="min-w-0 flex-1">
              <a href={`/contacts/${c.contactId}`} className="text-sm font-medium text-un1t-white hover:underline">
                {c.name}
              </a>
              <p className="text-xs text-un1t-light">
                {c.status?.replace(/_/g, ' ')} · joined {formatJoined(c.joinedAt)} · {c.reason}
              </p>
            </div>
            <Users size={14} className="shrink-0 text-un1t-mid" />
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── classpass (LEAD-CLASSPASS.1) ─────────────────────────────────
// Read-only awareness tab. ClassPass drop-ins rarely convert to a
// direct membership, so they sit out of the funnel — there are no
// triage actions here, just a filterable list.

function ClassPass({ data, filter, onFilter, summary }) {
  const cp = summary.classpass || { attending: 0, lapsed: 0 }
  const countFor = (key) => key === 'attending'
    ? cp.attending
    : key === 'lapsed'
      ? cp.lapsed
      : summary.classpassTotal

  return (
    <div>
      <p className="mb-3 rounded-lg border border-un1t-gray bg-un1t-dark p-3 text-xs text-un1t-light">
        ClassPass drop-ins pay per visit through ClassPass and rarely convert to a
        direct membership, so they sit outside the Funnel. This list is{' '}
        <strong>read-only</strong> — for awareness, not a follow-up queue.{' '}
        <em>Attending</em> means a class in the last 90 days.
      </p>

      {/* Attending / lapsed filter */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {CLASSPASS_FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => onFilter(f.key)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium ${
              filter === f.key
                ? 'bg-un1t-white text-un1t-black'
                : 'border border-un1t-gray text-un1t-light hover:text-un1t-white'
            }`}
          >
            {f.label} ({countFor(f.key)})
          </button>
        ))}
      </div>

      {data === null ? (
        <p className="text-sm text-un1t-light">Loading ClassPass…</p>
      ) : data.items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-un1t-gray p-10 text-center">
          <CreditCard size={28} className="mx-auto text-un1t-light" />
          <p className="mt-3 font-medium text-un1t-white">No ClassPass contacts here</p>
          <p className="mt-1 text-sm text-un1t-light">Nothing matches this filter.</p>
        </div>
      ) : (
        <ClassPassList data={data} />
      )}
    </div>
  )
}

function ClassPassList({ data }) {
  const items = data.items
  return (
    <div>
      {data.total > items.length && (
        <p className="mb-2 text-xs text-un1t-mid">
          Showing {items.length} of {data.total.toLocaleString('en-IE')} — narrow with the filter.
        </p>
      )}
      <ul className="space-y-1.5">
        {items.map((c) => (
          <li key={c.contactId}
            className="flex items-center gap-3 rounded-lg border border-un1t-gray bg-un1t-dark p-3">
            <div className="min-w-0 flex-1">
              <a href={`/contacts/${c.contactId}`} className="text-sm font-medium text-un1t-white hover:underline">
                {c.name}
              </a>
              <p className="text-xs text-un1t-light">
                {c.daysSinceActivity != null
                  ? `last class ${c.daysSinceActivity}d ago`
                  : 'no class activity'}
                {' · joined '}{formatJoined(c.joinedAt)}
              </p>
            </div>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
              c.attending ? 'bg-green-100 text-green-700' : 'bg-un1t-gray text-un1t-light'
            }`}>
              {c.attending ? 'Attending' : 'Lapsed'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
