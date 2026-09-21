'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { CalendarOff, Plus, Check, X, Palmtree, ThermometerSun, Ban, Wallet, CircleEllipsis, AlertTriangle } from 'lucide-react'
import { MANAGER_ROLES } from '@/lib/schemas'
import { dublinTodayStr } from '@/lib/dublin-time'
import { timeOffTypesFor, defaultTimeOffTypeFor, leaveClashLabel, leaveClashPrompt } from '@shared/time-off'
import Modal from '@/components/ui/Modal'
// LEAVEDAYS.1 — what the form's "days requested" line says, and when.
import { LEAVE_PREVIEW_DEBOUNCE_MS, leavePreviewRequest, leavePreviewFrom, leavePreviewState, leaveDaysView } from '@/lib/leave-days-preview'
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
  // LEAVE.2 — derived, not stored: pending past its end_date.
  expired:   'bg-un1t-border/30 text-un1t-muted',
}

// LEAVE.5 — `canApprove` is resolved by the page against the per-location
// time-off approval permission at the active studio. Without it (older
// callers, tests) the role at the active studio decides, as before.
export default function TimeOffManager({ user, canApprove }) {
  // BOOKKEEPER-APPROVALS-FIX — `?focus=<id>` arrives when the user
  // drilled in from /approvals. Default to the 'team' tab (the
  // request being approved belongs to someone else, not the
  // viewer) and 'pending' filter (the only status that needs
  // action). Otherwise we'd land on 'my' + 'all' and they'd see
  // their own holidays instead of the request they clicked.
  const searchParams = useSearchParams()
  const focusId = searchParams?.get('focus') || null
  const isManager = typeof canApprove === 'boolean' ? canApprove : MANAGER_ROLES.includes(user.role)
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
  // LEAVE.5 — approvers land on the team's requests; their own allowance
  // moves to a smaller section below.
  const [tab, setTab] = useState(isManager ? 'team' : 'my') // 'my' or 'team' (team only for managers)
  // LEAVE.1 — after an approval that left the person rostered:
  // { requestId, name, prompt } until "Unassign them" or "Keep them".
  const [clashFollowUp, setClashFollowUp] = useState(null)
  const [notice, setNotice] = useState(null)
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
    // LEAVE.1 — each open request carries how many live shifts it clashes with.
    params.set('with_clashes', '1')

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
    if (actingId) return null
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
        return null
      }
      await fetchData()
      return data
    } catch {
      setError({ title, message: 'Network error, please try again', retry: false })
      return null
    } finally {
      setActingId(null)
    }
  }

  async function handleApprove(id) {
    setClashFollowUp(null)
    setNotice(null)
    const result = await reviewRequest(id, { status: 'approved' }, 'Could not approve')
    // LEAVE.1 — approval never touches the roster. Show what it clashes with
    // and let the approver decide.
    const prompt = leaveClashPrompt(result?.clashes)
    if (prompt) {
      setClashFollowUp({ requestId: id, name: result?.data?.profiles?.full_name || null, prompt })
    } else if (result?.clashes_error) {
      setNotice(`Approved. ${result.clashes_error}.`)
    }
  }

  async function handleUnassignClashes() {
    if (!clashFollowUp || actingId) return
    const { requestId, prompt } = clashFollowUp
    setActingId(requestId)
    setError(null)
    try {
      const res = await fetch(`/api/schedule/time-off/${requestId}/unassign-clashes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignment_ids: prompt.assignmentIds }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        setError({ title: 'Could not unassign', message: data.error || 'The shifts were not changed.', retry: false })
        return
      }
      const removed = data.data?.removed?.length || 0
      const skipped = data.data?.skipped?.length || 0
      setClashFollowUp(null)
      setNotice(
        `Unassigned from ${removed} shift${removed === 1 ? '' : 's'}.` +
        (skipped ? ` ${skipped} at a studio you don't manage ${skipped === 1 ? 'was' : 'were'} left on the roster.` : ''),
      )
      await fetchData()
    } catch {
      setError({ title: 'Could not unassign', message: 'Network error, please try again', retry: false })
    } finally {
      setActingId(null)
    }
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

      {/* Allowance — the viewer's own. Coaches see it first; approvers see
          the team's requests first and their own allowance below (LEAVE.5). */}
      {!isManager && <AllowanceSummary allowance={allowance} />}

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

      {notice && (
        <div role="status" className="mb-4 flex items-start gap-3 p-3 rounded-lg border border-green-500/40 bg-green-500/10 text-sm text-green-700">
          <div className="flex-1">{notice}</div>
          <button type="button" onClick={() => setNotice(null)} className="text-xs underline">Dismiss</button>
        </div>
      )}

      {clashFollowUp && (
        <div role="alert" className="mb-4 p-3 rounded-lg border border-amber-500/40 bg-amber-500/10 text-sm">
          <div className="flex items-start gap-3">
            <AlertTriangle size={16} className="text-amber-700 mt-0.5 shrink-0" aria-hidden="true" />
            <div className="flex-1">
              <div className="font-medium text-amber-700">
                {clashFollowUp.name ? `${clashFollowUp.name}: ` : ''}{clashFollowUp.prompt.title}
              </div>
              <div className="text-xs text-amber-700 mt-1 whitespace-pre-line">{clashFollowUp.prompt.message}</div>
              <div className="flex gap-2 mt-2">
                <button
                  type="button"
                  onClick={handleUnassignClashes}
                  disabled={!!actingId}
                  className="text-xs font-medium px-3 py-1.5 rounded-lg bg-amber-500/20 text-amber-700 hover:bg-amber-500/30 disabled:opacity-50"
                >
                  Unassign them
                </button>
                <button
                  type="button"
                  onClick={() => setClashFollowUp(null)}
                  disabled={!!actingId}
                  className="text-xs px-3 py-1.5 rounded-lg border border-un1t-border text-un1t-subtle hover:text-un1t-text disabled:opacity-50"
                >
                  Keep them
                </button>
              </div>
            </div>
          </div>
        </div>
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
            // LEAVE.2 — an expired request (pending past its end date) can be
            // declined or withdrawn, not approved.
            const displayStatus = req.effective_status || req.status
            const canApprove = isManager && req.status === 'pending' && !isOwn
            const canApproveThis = canApprove && !req.expired
            const clashLabel = leaveClashLabel(req.clash_count)
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
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium uppercase ${STATUS_STYLES[displayStatus] || STATUS_STYLES[req.status]}`}>
                      {displayStatus}
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
                  {clashLabel && (
                    <div className="text-xs text-amber-700 mt-1 flex items-center gap-1">
                      <AlertTriangle size={12} aria-hidden="true" /> {clashLabel}
                    </div>
                  )}
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
                      {canApproveThis && <button
                        type="button"
                        onClick={() => handleApprove(req.id)}
                        disabled={!!actingId}
                        className="p-2 rounded-lg bg-green-500/20 hover:bg-green-500/30 text-green-700 disabled:opacity-50 transition-colors"
                        aria-label={`Approve ${requestLabel}`}
                        title="Approve"
                      >
                        <Check size={16} aria-hidden="true" />
                      </button>}
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

      {isManager && allowance && !allowance.not_applicable && (
        <section className="mt-8" aria-labelledby="own-allowance-heading">
          <h3 id="own-allowance-heading" className="text-xs uppercase tracking-wider text-un1t-subtle mb-2">Your allowance</h3>
          <AllowanceSummary allowance={allowance} compact />
        </section>
      )}

      {/* Request Form Modal */}
      {showForm && (
        <TimeOffFormModal
          user={user}
          canRecordForOthers={isManager}
          allowance={allowance}
          onClose={() => setShowForm(false)}
          onSubmit={(result) => {
            setShowForm(false)
            // LEAVE.5 — recorded leave is approved on the spot, so it can
            // clash with the roster exactly like an approval (LEAVE.1).
            const prompt = leaveClashPrompt(result?.clashes)
            if (prompt && result?.data?.id) {
              setClashFollowUp({ requestId: result.data.id, name: result.data.profiles?.full_name || null, prompt })
            }
            fetchData()
          }}
        />
      )}
    </div>
  )
}

// The viewer's holiday allowance. `compact` is the approver's secondary
// section. A contractor has none (LEAVE.3), so nothing renders.
function AllowanceSummary({ allowance, compact = false }) {
  if (!allowance || allowance.not_applicable) return null
  const cards = [
    { label: 'Total Allowance', value: allowance.total_days, tone: '' },
    { label: 'Used', value: allowance.used_days, tone: 'text-red-700' },
    { label: 'Carried Over', value: allowance.carried_over, tone: 'text-blue-700' },
    { label: 'Remaining', value: allowance.remaining, tone: 'text-green-700' },
  ]
  return (
    // ROSTER-FIX.6b — four allowance cards side by side put a 2xl number
    // in a ~85px column on a phone. Two up, four from md.
    <div className={`grid grid-cols-2 md:grid-cols-4 ${compact ? 'gap-2' : 'gap-3 mb-6'}`}>
      {cards.map((c) => (
        <div key={c.label} className={`bg-un1t-surface border border-un1t-border rounded-lg ${compact ? 'p-2.5' : 'p-4'}`}>
          <div className="text-xs text-un1t-subtle uppercase tracking-wider">{c.label}</div>
          <div className={`${compact ? 'text-base' : 'text-2xl'} font-bold mt-1 ${c.tone}`}>
            {c.value} <span className="text-sm text-un1t-subtle font-normal">days</span>
          </div>
        </div>
      ))}
    </div>
  )
}

function TimeOffFormModal({ user, canRecordForOthers = false, allowance, onClose, onSubmit }) {
  // LEAVE.5 — an approver can record leave for a colleague (who phoned in
  // sick, say). '' = the viewer's own request.
  const [subjectId, setSubjectId] = useState('')
  const [staff, setStaff] = useState([])
  const [type, setType] = useState(() => defaultTimeOffTypeFor(user.employment_type))
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const locationId = user.activeLocation?.id
  useEffect(() => {
    if (!canRecordForOthers || !locationId) return
    let live = true
    readJson(`/api/staff?fields=picker&location_id=${locationId}`)
      .then((res) => {
        if (!live) return
        const rows = Array.isArray(res.data) ? res.data : []
        setStaff(rows.filter((p) => p && p.id !== user.id && p.active !== false))
      })
      .catch(() => { /* the picker is optional; the own-request form still works */ })
    return () => { live = false }
  }, [canRecordForOthers, locationId, user.id])

  const subject = subjectId ? staff.find((p) => p.id === subjectId) || null : null
  const onBehalf = !!subject
  // LEAVE.3 — the menu follows the PERSON the leave is for: a contractor is
  // only offered Unavailable. The server enforces the same rule.
  const employmentType = onBehalf ? subject.employment_type : user.employment_type
  const typeOptions = timeOffTypesFor(employmentType)
  const effectiveType = typeOptions.some((t) => t.value === type) ? type : defaultTimeOffTypeFor(employmentType)

  const dirty = !!(startDate || endDate || reason.trim() || subjectId)

  const totalDays = startDate && endDate
    ? Math.max(1, Math.round((new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60 * 24)) + 1)
    : 0

  // LEAVEDAYS.1 — `totalDays` above is a CALENDAR count. The server charges a
  // holiday in working days (no weekends, bank holidays or studio closures —
  // HOLIDAYLEAVE.1), so the line under the dates shows the server's number,
  // from the preview the phone already uses (LEAVEPHONE.1), and judges
  // "exceeds balance" on that alone. Asked for the studio this form POSTs to,
  // and only for a holiday: every other type IS charged in calendar days.
  // The days depend on the studio and the dates, not the person, so this is
  // right for an on-behalf request too; the preview's `clashes` are the
  // CALLER's own shifts and are never read here.
  const previewRequest = leavePreviewRequest({ type: effectiveType, startDate, endDate, locationId })
  const previewKey = previewRequest?.key || null
  const previewUrl = previewRequest?.url || null
  // { key, known, days } — only ever shown for the key it was asked with.
  const [previewResult, setPreviewResult] = useState(null)
  useEffect(() => {
    if (!previewUrl) return
    // Date inputs fire on every change: wait for a pause, and let only the
    // newest request speak. The abort covers the network; the flag covers a
    // body that arrives anyway.
    const controller = new AbortController()
    const timer = setTimeout(() => {
      readJson(previewUrl, { signal: controller.signal })
        .then((res) => leavePreviewFrom(res), () => leavePreviewFrom(null))
        .then((next) => {
          if (!controller.signal.aborted) setPreviewResult({ key: previewKey, ...next })
        })
    }, LEAVE_PREVIEW_DEBOUNCE_MS)
    return () => { clearTimeout(timer); controller.abort() }
  }, [previewKey, previewUrl])
  const daysView = leaveDaysView({
    calendarDays: totalDays, preview: leavePreviewState(previewRequest, previewResult),
    type: effectiveType, onBehalf, allowance, startDate, endDate,
  })

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
          type: effectiveType,
          start_date: startDate,
          end_date: endDate,
          reason: reason || null,
          location_id: locationId,
          ...(onBehalf ? { profile_id: subject.id } : {}),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        setError(data.error || 'Failed to submit request')
        return
      }
      onSubmit(data)
    } catch {
      setError('Network error, please try again')
    } finally {
      setSaving(false)
    }
  }

  return (
    // ROSTER-FIX.6b — once any field is filled the backdrop stops dismissing:
    // this form is long enough that losing it to a stray click is a real cost.
    <Modal open onClose={onClose} title={onBehalf ? 'Record Time Off' : 'Request Time Off'} dismissOnBackdrop={!dirty}>
      <div>
        {error && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-lg p-3 mb-4">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {canRecordForOthers && staff.length > 0 && (
            <div>
              <label htmlFor="time-off-subject" className="block text-xs text-un1t-subtle mb-1">For</label>
              <select
                id="time-off-subject"
                value={subjectId}
                onChange={(e) => setSubjectId(e.target.value)}
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
              >
                <option value="">Myself</option>
                {staff.map((p) => (
                  <option key={p.id} value={p.id}>{p.full_name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Type selection — the shared catalogue, gated by the employment
              type of the person the leave is for (LEAVE.3). Icon + colour come
              from TYPE_CONFIG, with a neutral fallback. */}
          <div>
            <label className="block text-xs text-un1t-subtle mb-2">Type</label>
            <div className="grid grid-cols-3 gap-2">
              {typeOptions.map(({ value, label }) => {
                const conf = TYPE_CONFIG[value] || FALLBACK_TYPE
                const Icon = conf.icon
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setType(value)}
                    aria-pressed={effectiveType === value}
                    className={`flex flex-col items-center gap-1.5 p-3 rounded-lg border text-xs transition-colors ${
                      effectiveType === value
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
                min={onBehalf ? undefined : dublinTodayStr()}
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
                min={startDate || (onBehalf ? undefined : dublinTodayStr())}
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
              />
            </div>
          </div>

          {/* Reason */}
          <div>
            {/* LEAVEDAYS.1 — the days line is the form's only warning before
                submit, so it is a live region, and one that is ALWAYS mounted:
                a region that arrives together with its content is not
                announced. It sits inside this block rather than as its own
                child of the form because the form is `space-y-4`, which would
                give an empty region a 1rem gap of its own; the line carries
                that gap itself (`mb-4`). "Counting days..." is aria-hidden so
                each settled line is announced once, whole (aria-atomic), and
                the wait before it is not. */}
            <div aria-live="polite" aria-atomic="true">
              {daysView && (
                <div className="text-sm text-un1t-subtle mb-4" aria-hidden={daysView.transient ? 'true' : undefined}>
                  {daysView.text}
                  {daysView.balance && (
                    <span className="ml-2">
                      · {daysView.balance}
                      {daysView.exceeds && (
                        <span className="text-red-700 ml-1">(exceeds balance)</span>
                      )}
                    </span>
                  )}
                  {daysView.hint && <div className="text-xs text-un1t-subtle mt-1">{daysView.hint}</div>}
                  {daysView.note && <div className="text-xs text-un1t-subtle mt-1">{daysView.note}</div>}
                </div>
              )}
            </div>
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
            {saving ? 'Submitting...' : (onBehalf ? 'Record Time Off' : 'Submit Request')}
          </button>
          <p className="text-xs text-un1t-muted text-center">
            {onBehalf
              ? `Recorded as approved for ${subject.full_name}. They will be notified.`
              : 'Your request will be reviewed by a manager'}
          </p>
        </form>
      </div>
    </Modal>
  )
}
