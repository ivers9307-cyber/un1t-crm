'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { CalendarOff, Plus, Check, X, Palmtree, ThermometerSun, Ban, Wallet, CircleEllipsis } from 'lucide-react'
import { MANAGER_ROLES } from '@/lib/schemas'
import { dublinTodayStr } from '@/lib/dublin-time'
import { TIME_OFF_TYPES } from '@shared/time-off'
import Modal from '@/components/ui/Modal'
// ROSTER-FIX.6a — one failure shape and one banner across the schedule
// screens, so no call site can quietly forget to check the response.
import ScheduleErrorBanner from './schedule/ScheduleErrorBanner'
import { readJson } from './schedule/useScheduleData'

// All five time-off types (mig 283). The manager screen renders every type
// that can land in the table — including legacy/unknown values via the
// FALLBACK_TYPE guard below.
const TYPE_CONFIG = {
  holiday:     { label: 'Holiday',      color: '#22C55E', bg: '#22C55E20', icon: Palmtree },
  sick:        { label: 'Sick Leave',   color: '#EF4444', bg: '#EF444420', icon: ThermometerSun },
  unpaid:      { label: 'Unpaid Leave', color: '#6366F1', bg: '#6366F120', icon: Wallet },
  other:       { label: 'Other',        color: '#64748B', bg: '#64748B20', icon: CircleEllipsis },
  unavailable: { label: 'Unavailable',  color: '#F59E0B', bg: '#F59E0B20', icon: Ban },
}

// Neutral fallback so an unknown legacy `type` value never crashes a row.
const FALLBACK_TYPE = { label: 'Time off', color: '#64748B', bg: '#64748B20', icon: CircleEllipsis }

const STATUS_STYLES = {
  pending:   'bg-yellow-500/20 text-yellow-700',
  approved:  'bg-green-500/20 text-green-700',
  rejected:  'bg-red-500/20 text-red-700',
  cancelled: 'bg-un1t-border/30 text-un1t-muted',
}

export default function TimeOffManager({ user }) {
  // BOOKKEEPER-APPROVALS-FIX — `?focus=<id>` arrives when the user
  // drilled in from /approvals. Default to the 'team' tab (the
  // request being approved belongs to someone else, not the
  // viewer) and 'pending' filter (the only status that needs
  // action). Otherwise we'd land on 'my' + 'all' and they'd see
  // their own holidays instead of the request they clicked.
  const searchParams = useSearchParams()
  const focusId = searchParams?.get('focus') || null
  const isManager = MANAGER_ROLES.includes(user.role)
  const hasFocus = !!focusId && isManager

  const [requests, setRequests] = useState([])
  const [allowance, setAllowance] = useState(null)
  const [loading, setLoading] = useState(true)
  // ROSTER-FIX.6a — fetchData had no try/catch and cleared `loading` on the
  // happy path only, so a dropped network or a 500 left this screen on
  // "Loading requests..." forever with nothing said. Every failure now names
  // itself and offers a retry (memory: discarded-error defect class).
  //
  // ROSTER-FIX.6a-8 — the same state carries load failures AND action
  // failures, so a hard-coded "Could not load time off" title sat over a
  // refused approve and its Retry re-ran the LOAD, which "succeeds" and hides
  // the fact that the approval never happened. The failure now carries its own
  // title and says whether retrying means anything: { title, message, retry }.
  const [error, setError] = useState(null)
  // Single-flight guard: approve/reject/cancel are one-shot decisions, and
  // double-clicking used to fire two PUTs.
  const [actingId, setActingId] = useState(null)
  const [showForm, setShowForm] = useState(false)
  const [filter, setFilter] = useState(hasFocus ? 'pending' : 'all') // 'all', 'pending', 'approved'
  const [tab, setTab] = useState(hasFocus ? 'team' : 'my') // 'my' or 'team' (team only for managers)
  // Ref-map of request id → DOM node so we can scroll the focused
  // row into view once it lands in the result set.
  const rowRefs = useRef(new Map())
  const focusScrolled = useRef(false)

  // APPROVALS-LOCATION-SCOPE — drop the old override-location-id
  // plumbing. The /approvals provider now filters by activeLocation
  // so the drill-in always lands on the right list.
  const locationId = user.activeLocation?.id

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    const params = new URLSearchParams()
    if (locationId) params.set('location_id', locationId)
    if (filter !== 'all') params.set('status', filter)
    if (tab === 'my') params.set('profile_id', user.id)

    try {
      const [reqRes, allowRes] = await Promise.all([
        readJson(`/api/schedule/time-off?${params}`),
        readJson(`/api/schedule/allowances?profile_id=${user.id}&year=${new Date().getFullYear()}`),
      ])
      setRequests(reqRes.data || [])
      setAllowance(allowRes.data || null)
    } catch (e) {
      setError({ title: 'Could not load time off', message: e?.message || 'The request failed.', retry: true })
    } finally {
      setLoading(false)
    }
  }, [locationId, filter, tab, user.id])

  useEffect(() => { fetchData() }, [fetchData])

  // BOOKKEEPER-APPROVALS-FIX — after data lands, two things:
  //   1. If we expected the focused row on this tab but it isn't
  //      there, flip the tab once and re-fetch (covers the rare
  //      case where the user clicked their OWN pending request in
  //      /approvals — initial guess of 'team' is wrong).
  //   2. Once the focused row IS in the result set, scroll it
  //      into view + highlight it. Only fires once so subsequent
  //      re-fetches don't yank the scroll position.
  const fallbackTried = useRef(false)
  useEffect(() => {
    if (!focusId || loading) return
    const inResults = requests.some((r) => r.id === focusId)
    if (!inResults && !fallbackTried.current) {
      fallbackTried.current = true
      // Initial guess (team) was wrong — try 'my'. Also broaden
      // filter so 'pending' isn't excluding it.
      setTab((t) => (t === 'team' ? 'my' : 'team'))
      setFilter('all')
      return
    }
    if (focusScrolled.current) return
    const node = rowRefs.current.get(focusId)
    if (node) {
      node.scrollIntoView({ behavior: 'smooth', block: 'center' })
      focusScrolled.current = true
    }
  }, [focusId, loading, requests])

  // One wrapped review action for all three decisions. Each used to check
  // `data.success` alone, so a 500 that returned an HTML error page threw a
  // JSON parse error into a discarded promise and the click did nothing
  // visible at all.
  // ROSTER-FIX.6a-8 — `title` names the ACTION that failed, not the screen, so
  // a refused approve reads "Could not approve". retry:false because retrying
  // a failed approve by re-running the load would report success while the
  // request is still sitting there pending.
  async function reviewRequest(id, body, title) {
    if (actingId) return
    setActingId(id)
    setError(null)
    try {
      const res = await fetch(`/api/schedule/time-off/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        setError({ title, message: data.error || 'The request was not updated.', retry: false })
        return
      }
      await fetchData()
    } catch {
      setError({ title, message: 'Network error, please try again', retry: false })
    } finally {
      setActingId(null)
    }
  }

  async function handleApprove(id) {
    await reviewRequest(id, { status: 'approved' }, 'Could not approve')
  }

  async function handleReject(id, note) {
    const reviewNote = note || prompt('Reason for rejection (optional):')
    await reviewRequest(id, { status: 'rejected', review_note: reviewNote || null }, 'Could not reject')
  }

  async function handleCancel(id) {
    if (!confirm('Cancel this time-off request?')) return
    await reviewRequest(id, { status: 'cancelled' }, 'Could not cancel')
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Time Off</h2>
          <p className="text-sm text-un1t-subtle mt-1">
            {user.activeLocation?.name} — Holiday & leave management
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm(true)}
          className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg bg-un1t-text text-un1t-bg font-medium hover:bg-un1t-accent transition-colors"
        >
          <Plus size={16} /> Request Time Off
        </button>
      </div>

      {/* Allowance Card */}
      {allowance && (
        // ROSTER-FIX.6b — four allowance cards side by side put a 2xl number
        // in a ~85px column on a phone. Two up, four from md.
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
            <div className="text-xs text-un1t-subtle uppercase tracking-wider">Total Allowance</div>
            <div className="text-2xl font-bold mt-1">{allowance.total_days} <span className="text-sm text-un1t-subtle">days</span></div>
          </div>
          <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
            <div className="text-xs text-un1t-subtle uppercase tracking-wider">Used</div>
            <div className="text-2xl font-bold mt-1 text-red-700">{allowance.used_days} <span className="text-sm text-un1t-subtle">days</span></div>
          </div>
          <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
            <div className="text-xs text-un1t-subtle uppercase tracking-wider">Carried Over</div>
            <div className="text-2xl font-bold mt-1 text-blue-700">{allowance.carried_over} <span className="text-sm text-un1t-subtle">days</span></div>
          </div>
          <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
            <div className="text-xs text-un1t-subtle uppercase tracking-wider">Remaining</div>
            <div className="text-2xl font-bold mt-1 text-green-700">{allowance.remaining} <span className="text-sm text-un1t-subtle">days</span></div>
          </div>
        </div>
      )}

      {/* Tabs & Filters */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex bg-un1t-surface border border-un1t-border rounded-lg overflow-hidden text-xs">
          <button
            type="button"
            onClick={() => setTab('my')}
            className={`px-3 py-2 transition-colors ${tab === 'my' ? 'bg-un1t-text text-un1t-bg' : 'text-un1t-subtle hover:text-un1t-text'}`}
          >
            My Requests
          </button>
          {isManager && (
            <button
              type="button"
              onClick={() => setTab('team')}
              className={`px-3 py-2 transition-colors ${tab === 'team' ? 'bg-un1t-text text-un1t-bg' : 'text-un1t-subtle hover:text-un1t-text'}`}
            >
              Team Requests
            </button>
          )}
        </div>

        <div className="flex gap-1.5 text-xs">
          {['all', 'pending', 'approved', 'rejected'].map(f => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-full transition-colors capitalize ${filter === f ? 'bg-un1t-text text-un1t-bg' : 'bg-un1t-surface border border-un1t-border text-un1t-subtle hover:text-un1t-text'}`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <ScheduleErrorBanner
          title={error.title}
          message={error.message}
          onRetry={error.retry ? fetchData : undefined}
          busy={loading}
          onDismiss={() => setError(null)}
        />
      )}

      {/* Requests List */}
      {loading ? (
        <div className="text-center py-16 text-un1t-subtle">Loading requests...</div>
      ) : requests.length === 0 ? (
        <div className="text-center py-16">
          <CalendarOff size={40} className="mx-auto text-un1t-muted mb-3" />
          <p className="text-un1t-subtle text-sm">No time-off requests found</p>
        </div>
      ) : (
        <div className="space-y-2">
          {requests.map(req => {
            const typeConf = TYPE_CONFIG[req.type] || FALLBACK_TYPE
            const TypeIcon = typeConf.icon
            const isOwn = req.profile_id === user.id
            const canApprove = isManager && req.status === 'pending' && !isOwn
            const canCancel = isOwn && req.status === 'pending'
            // ROSTER-FIX.6b — the approve/reject/cancel controls are icon-only
            // and repeat down the list, so "Approve" alone would read as the
            // same control fifteen times. Name the row they act on.
            const requestLabel = `${typeConf.label} request${req.profiles?.full_name ? ` from ${req.profiles.full_name}` : ''}`

            const isFocused = req.id === focusId
            return (
              <div
                key={req.id}
                ref={(node) => {
                  if (node) rowRefs.current.set(req.id, node)
                  else rowRefs.current.delete(req.id)
                }}
                className={`bg-un1t-surface border rounded-lg p-4 flex items-center gap-4 transition-colors ${
                  isFocused
                    ? 'border-un1t-text ring-2 ring-un1t-text/40'
                    : 'border-un1t-border'
                }`}
              >
                {/* Type icon */}
                <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0" style={{ backgroundColor: typeConf.bg }}>
                  <TypeIcon size={20} style={{ color: typeConf.color }} />
                </div>

                {/* Details */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    {tab === 'team' && (
                      <span className="font-semibold text-sm">{req.profiles?.full_name}</span>
                    )}
                    <span className="text-sm font-medium" style={{ color: typeConf.color }}>{typeConf.label}</span>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium uppercase ${STATUS_STYLES[req.status]}`}>
                      {req.status}
                    </span>
                  </div>
                  <div className="text-xs text-un1t-subtle mt-1 flex items-center gap-3">
                    <span>
                      {new Date(req.start_date + 'T00:00:00').toLocaleDateString('en-IE', { day: 'numeric', month: 'short' })}
                      {req.start_date !== req.end_date && ` – ${new Date(req.end_date + 'T00:00:00').toLocaleDateString('en-IE', { day: 'numeric', month: 'short' })}`}
                    </span>
                    <span>{req.total_days} day{req.total_days !== 1 ? 's' : ''}</span>
                    {req.reason && <span className="text-un1t-muted truncate max-w-[200px]" title={req.reason}>{req.reason}</span>}
                  </div>
                  {req.review_note && (
                    <div className="text-xs text-un1t-muted mt-1 italic">
                      Note: {req.review_note} {req.reviewer && `— ${req.reviewer.full_name}`}
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 shrink-0">
                  {canApprove && (
                    <>
                      <button
                        type="button"
                        onClick={() => handleApprove(req.id)}
                        disabled={!!actingId}
                        className="p-2 rounded-lg bg-green-500/20 hover:bg-green-500/30 text-green-700 disabled:opacity-50 transition-colors"
                        aria-label={`Approve ${requestLabel}`}
                        title="Approve"
                      >
                        <Check size={16} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleReject(req.id)}
                        disabled={!!actingId}
                        className="p-2 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-700 disabled:opacity-50 transition-colors"
                        aria-label={`Reject ${requestLabel}`}
                        title="Reject"
                      >
                        <X size={16} aria-hidden="true" />
                      </button>
                    </>
                  )}
                  {canCancel && (
                    <button
                      type="button"
                      onClick={() => handleCancel(req.id)}
                      aria-label={`Cancel ${requestLabel}`}
                      disabled={!!actingId}
                      className="text-xs px-3 py-1.5 rounded-lg border border-un1t-border text-un1t-subtle hover:text-red-700 hover:border-red-500/30 disabled:opacity-50 transition-colors"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Request Form Modal */}
      {showForm && (
        <TimeOffFormModal
          user={user}
          allowance={allowance}
          onClose={() => setShowForm(false)}
          onSubmit={() => { setShowForm(false); fetchData() }}
        />
      )}
    </div>
  )
}

function TimeOffFormModal({ user, allowance, onClose, onSubmit }) {
  const [type, setType] = useState('holiday')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const dirty = !!(startDate || endDate || reason.trim())

  const totalDays = startDate && endDate
    ? Math.max(1, Math.round((new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60 * 24)) + 1)
    : 0

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setSaving(true)

    // ROSTER-FIX.6a — a thrown fetch used to leave the button on "Submitting…"
    // with the modal open and nothing said.
    try {
      const res = await fetch('/api/schedule/time-off', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          start_date: startDate,
          end_date: endDate,
          reason: reason || null,
          location_id: user.activeLocation?.id,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        setError(data.error || 'Failed to submit request')
        return
      }
      onSubmit()
    } catch {
      setError('Network error, please try again')
    } finally {
      setSaving(false)
    }
  }

  return (
    // ROSTER-FIX.6b — once any field is filled the backdrop stops dismissing:
    // this form is long enough that losing it to a stray click is a real cost.
    <Modal open onClose={onClose} title="Request Time Off" dismissOnBackdrop={!dirty}>
      <div>
        {error && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-lg p-3 mb-4">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Type selection — driven by the shared catalogue (all five types;
              managers recording on behalf are not employment-gated). Icon +
              colour come from TYPE_CONFIG, with a neutral fallback. */}
          <div>
            <label className="block text-xs text-un1t-subtle mb-2">Type</label>
            <div className="grid grid-cols-3 gap-2">
              {TIME_OFF_TYPES.map(({ value, label }) => {
                const conf = TYPE_CONFIG[value] || FALLBACK_TYPE
                const Icon = conf.icon
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setType(value)}
                    className={`flex flex-col items-center gap-1.5 p-3 rounded-lg border text-xs transition-colors ${
                      type === value
                        ? 'border-un1t-text/40 bg-un1t-border/30'
                        : 'border-un1t-border hover:border-white/20'
                    }`}
                  >
                    <Icon size={18} style={{ color: conf.color }} />
                    <span>{label}</span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Dates */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-un1t-subtle mb-1">Start Date *</label>
              <input
                type="date"
                required
                value={startDate}
                onChange={e => {
                  setStartDate(e.target.value)
                  if (!endDate || e.target.value > endDate) setEndDate(e.target.value)
                }}
                min={dublinTodayStr()}
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
              />
            </div>
            <div>
              <label className="block text-xs text-un1t-subtle mb-1">End Date *</label>
              <input
                type="date"
                required
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
                min={startDate || dublinTodayStr()}
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
              />
            </div>
          </div>

          {totalDays > 0 && (
            <div className="text-sm text-un1t-subtle">
              {totalDays} day{totalDays !== 1 ? 's' : ''} requested
              {type === 'holiday' && allowance && (
                <span className="ml-2">
                  · {allowance.remaining} remaining
                  {totalDays > allowance.remaining && (
                    <span className="text-red-700 ml-1">(exceeds balance)</span>
                  )}
                </span>
              )}
            </div>
          )}

          {/* Reason */}
          <div>
            <label className="block text-xs text-un1t-subtle mb-1">Reason (optional)</label>
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              rows={2}
              placeholder="e.g. Family holiday, doctor's appointment..."
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text resize-none"
            />
          </div>

          <button
            type="submit"
            disabled={!startDate || !endDate || saving}
            className="w-full bg-un1t-text text-un1t-bg font-medium text-sm py-2.5 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50"
          >
            {saving ? 'Submitting...' : 'Submit Request'}
          </button>
          <p className="text-xs text-un1t-muted text-center">
            Your request will be reviewed by a manager
          </p>
        </form>
      </div>
    </Modal>
  )
}
