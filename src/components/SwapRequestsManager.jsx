'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { ArrowLeft, ArrowLeftRight, Check, X, AlertCircle } from 'lucide-react'
import { MANAGER_ROLES } from '@/lib/schemas'
// ROSTER-FIX.6a — one failure shape and one banner across the schedule
// screens, so no call site can quietly forget to check the response.
import ScheduleErrorBanner from './schedule/ScheduleErrorBanner'
import { readJson } from './schedule/useScheduleData'

const canManage = (role) => MANAGER_ROLES.includes(role)

// A swap a manager can act on: an open/targeted request (pending) OR one a
// coach has already claimed/accepted (awaiting_approval — the real decision
// queue). Both are surfaced to the /approvals inbox by the shift-swaps
// provider, and resolveSwapTransition accepts a manager approve/reject from
// either, so the manager page must show the buttons for both. (Gating on
// 'pending' alone was the "claimed swap has no Approve button" bug.)
const REVIEW_STATES = ['pending', 'awaiting_approval']

const FILTERS = [
  { key: 'review', label: 'To review', match: (s) => REVIEW_STATES.includes(s) },
  { key: 'approved', label: 'Approved', match: (s) => s === 'approved' },
  { key: 'rejected', label: 'Rejected', match: (s) => s === 'rejected' },
  { key: 'all', label: 'All', match: () => true },
]

const STATUS_LABEL = {
  pending: 'Pending',
  awaiting_approval: 'Claimed',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
}

// Light-theme ramps (-700 text on a 10-20% tint) per the palette convention.
const statusColors = {
  pending: 'bg-yellow-500/15 text-yellow-700',
  awaiting_approval: 'bg-blue-500/15 text-blue-700',
  approved: 'bg-green-500/15 text-green-700',
  rejected: 'bg-red-500/15 text-red-700',
  cancelled: 'bg-gray-500/15 text-gray-600',
}

function formatTime(time) {
  if (!time) return ''
  const [h, m] = time.split(':')
  const hour = parseInt(h)
  const suffix = hour >= 12 ? 'pm' : 'am'
  const display = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour
  return m === '00' ? `${display}${suffix}` : `${display}:${m}${suffix}`
}

function formatDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-IE', {
    weekday: 'short', day: 'numeric', month: 'short'
  })
}

// ROSTER-FIX.8e — created_at is a full timestamp, not the 'YYYY-MM-DD' string
// formatDate() takes, so a detached swap needs its own formatter. Returns ''
// rather than 'Invalid Date' so the caller can drop the clause entirely.
function formatPostedOn(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function SwapRequestsManager({ user }) {
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('review')
  const [actingId, setActingId] = useState(null)
  // ROSTER-FIX.6a — the load cleared `loading` on the happy path only, so a
  // refused or dropped request left this screen on "Loading requests..."
  // forever with nothing said.
  //
  // ROSTER-FIX.6a-8 — one state serves load failures AND approve/reject
  // failures, so the banner's hard-coded "Could not load swap requests" title
  // sat over a refused approve and its Retry re-ran the LOAD, which succeeds
  // and hides the fact the swap was never approved. Each failure now carries
  // its own title and whether a retry means anything: { title, message, retry }.
  const [error, setError] = useState(null)
  const searchParams = useSearchParams()
  const focusId = searchParams.get('focus')
  const locationId = user.activeLocation?.id
  const isManager = canManage(user.role)

  // Fetch every swap for the location once and filter client-side. Volume is
  // low (the approvals provider caps at 50), and the previous server-side
  // ?status=pending filter silently hid awaiting_approval rows — the reason a
  // claimed swap drilled in from /approvals showed an empty list.
  const fetchRequests = useCallback(async () => {
    if (!locationId) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const data = await readJson(`/api/schedule/swaps?location_id=${locationId}`)
      setRequests(data.data || [])
    } catch (e) {
      setError({ title: 'Could not load swap requests', message: e?.message || 'The request failed.', retry: true })
    } finally {
      setLoading(false)
    }
  }, [locationId])

  useEffect(() => { fetchRequests() }, [fetchRequests])

  // Drill-in from the /approvals inbox lands here with ?focus=<id> — scroll
  // it into view + ring-highlight so the manager sees exactly which one.
  useEffect(() => {
    if (!focusId || loading) return
    const el = document.getElementById(`swap-${focusId}`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [focusId, loading, filter])

  async function handleAction(id, status, note) {
    if (actingId) return
    setActingId(id)
    setError(null)
    const verb = status === 'approved' ? 'approve' : status === 'rejected' ? 'reject' : 'update'
    // retry:false — re-running the LOAD would report success while the swap
    // sits exactly where it was.
    const title = `Could not ${verb}`
    try {
      const res = await fetch(`/api/schedule/swaps/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, review_note: note }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        setError({ title, message: data.error || 'Unknown error', retry: false })
        return
      }
      await fetchRequests()
    } catch {
      // ROSTER-FIX.6a — a thrown fetch used to reject into a discarded
      // promise: the row un-busied and the swap looked handled.
      setError({
        title,
        message: `Network error, the swap was not ${status === 'approved' ? 'approved' : status === 'rejected' ? 'rejected' : 'updated'}. Please try again.`,
        retry: false,
      })
    } finally {
      setActingId(null)
    }
  }

  const activeFilter = FILTERS.find(f => f.key === filter) || FILTERS[0]
  const visible = requests.filter(r => activeFilter.match(r.status))

  return (
    <div>
      <Link href="/schedule" className="inline-flex items-center gap-1.5 text-sm text-un1t-subtle hover:text-un1t-text mb-6">
        <ArrowLeft size={16} /> Back to Schedule
      </Link>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Swap Requests</h2>
          <p className="text-sm text-un1t-subtle mt-1">Review and manage shift swap requests</p>
        </div>
        <div className="flex bg-un1t-surface border border-un1t-border rounded-lg overflow-hidden text-xs">
          {FILTERS.map(f => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`px-3 py-2 transition-colors ${filter === f.key ? 'bg-un1t-text text-un1t-bg' : 'text-un1t-subtle hover:text-un1t-text'}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <ScheduleErrorBanner
          title={error.title}
          message={error.message}
          onRetry={error.retry ? fetchRequests : undefined}
          busy={loading}
          onDismiss={() => setError(null)}
        />
      )}

      {loading ? (
        <div className="text-center py-12 text-un1t-subtle">Loading requests...</div>
      ) : visible.length === 0 ? (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-12 text-center">
          <ArrowLeftRight size={40} className="mx-auto mb-4 text-un1t-subtle" />
          <h3 className="text-lg font-semibold mb-2">No swap requests</h3>
          <p className="text-sm text-un1t-subtle">
            {filter === 'review' ? 'Nothing to review right now' : 'No requests match this filter'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map(req => {
            const reqShift = req.requester_shift
            const reqTmpl = reqShift?.shift_templates || {}
            const tgtShift = req.target_shift
            const tgtTmpl = tgtShift?.shift_templates || {}
            const canReview = isManager && REVIEW_STATES.includes(req.status)
            const canCancelOwn = !isManager && req.requester_id === user.id && REVIEW_STATES.includes(req.status)
            const focused = focusId && req.id === focusId
            // ROSTER-FIX.8e — the only date a detached swap still has.
            const postedOn = formatPostedOn(req.created_at)
            const busy = actingId === req.id

            return (
              <div
                key={req.id}
                id={`swap-${req.id}`}
                className={`bg-un1t-surface border rounded-lg p-4 transition-colors ${focused ? 'border-un1t-text ring-1 ring-un1t-text' : 'border-un1t-border'}`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    {/* Requester info */}
                    <div className="flex items-center gap-2 mb-2">
                      <span className="font-semibold">{req.requester?.full_name}</span>
                      {req.target?.full_name && (
                        <span className="text-un1t-subtle text-sm">↔ {req.target.full_name}</span>
                      )}
                      <span className={`text-xs px-2 py-0.5 rounded-full ${statusColors[req.status] || 'bg-gray-500/15 text-gray-600'}`}>
                        {STATUS_LABEL[req.status] || req.status}
                      </span>
                    </div>

                    {/* Their shift */}
                    {/* ROSTER-FIX.8e — a swap row now OUTLIVES the assignment it
                        was about: mig 603 made requester_shift_id ON DELETE SET
                        NULL so an approved drop keeps its history instead of
                        cascading it away. Every such row reaches this card with
                        requester_shift null, and the old markup rendered
                        "Wants to swap:" followed by nothing at all — a blank
                        line where the shift used to be, with no hint that this
                        is history rather than a broken card. Say what happened
                        and date it from the request itself, which is the one
                        fact that survives. */}
                    {reqShift ? (
                      <div className="text-sm">
                        <span className="text-un1t-subtle">Wants to swap: </span>
                        <span className="font-medium" style={{ color: reqTmpl.color }}>
                          {reqTmpl.name}
                        </span>
                        <span className="text-un1t-subtle">
                          {' '} on {formatDate(reqShift.shift_date)} ({formatTime(reqShift.start_time_override || reqTmpl.start_time)}–{formatTime(reqShift.end_time_override || reqTmpl.end_time)})
                        </span>
                      </div>
                    ) : (
                      <div className="text-sm text-un1t-subtle flex items-center gap-1">
                        <AlertCircle size={12} />
                        <span>
                          Shift no longer on the roster
                          {postedOn && <span> (requested {postedOn})</span>}
                        </span>
                      </div>
                    )}

                    {/* Target shift if specified */}
                    {tgtShift && (
                      <div className="text-sm mt-1">
                        <span className="text-un1t-subtle">For: </span>
                        <span className="font-medium">{req.target?.full_name}'s</span>
                        <span className="font-medium" style={{ color: tgtTmpl.color }}> {tgtTmpl.name}</span>
                        <span className="text-un1t-subtle">
                          {' '} on {formatDate(tgtShift.shift_date)}
                        </span>
                      </div>
                    )}

                    {/* ROSTER-FIX.8e — the other side of the same hole. The FK on
                        target_shift_id has been ON DELETE SET NULL since mig 237,
                        so a detached target usually nulls the id too and is
                        indistinguishable from "no reciprocal shift was named".
                        What IS detectable is an id that is still set while the
                        embed resolved to nothing, and that used to render as
                        silence. */}
                    {req.target_shift_id && !tgtShift && (
                      <div className="text-sm mt-1 text-un1t-subtle flex items-center gap-1">
                        <AlertCircle size={12} />
                        <span>
                          Their shift is no longer on the roster
                          {postedOn && <span> (requested {postedOn})</span>}
                        </span>
                      </div>
                    )}

                    {/* ROSTER-FIX.8e — only when no reciprocal shift was ever
                        named. A row whose target_shift_id is still set but did
                        not resolve is covered above, and calling that a drop
                        request would be a plain misstatement of what the coach
                        asked for. */}
                    {!tgtShift && !req.target_shift_id && (
                      <div className="text-sm mt-1 text-un1t-subtle flex items-center gap-1">
                        <AlertCircle size={12} /> Requesting to drop this shift (no swap)
                      </div>
                    )}

                    {req.reason && (
                      <div className="text-xs text-un1t-muted mt-2 italic">"{req.reason}"</div>
                    )}

                    {req.review_note && (
                      <div className="text-xs text-un1t-subtle mt-1">Manager note: {req.review_note}</div>
                    )}
                  </div>

                  {/* Actions */}
                  {canReview && (
                    <div className="flex items-center gap-2 ml-4">
                      <button
                        disabled={busy}
                        onClick={() => handleAction(req.id, 'approved')}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-md bg-green-500/20 text-green-700 hover:bg-green-500/30 text-xs transition-colors disabled:opacity-50"
                      >
                        <Check size={14} /> Approve
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => {
                          const note = prompt('Reason for rejection (optional):')
                          handleAction(req.id, 'rejected', note)
                        }}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-md bg-red-500/20 text-red-700 hover:bg-red-500/30 text-xs transition-colors disabled:opacity-50"
                      >
                        <X size={14} /> Reject
                      </button>
                    </div>
                  )}

                  {/* Staff can cancel their own non-terminal requests */}
                  {canCancelOwn && (
                    <button
                      disabled={busy}
                      onClick={() => handleAction(req.id, 'cancelled')}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-md bg-gray-500/20 text-gray-600 hover:bg-gray-500/30 text-xs transition-colors ml-4 disabled:opacity-50"
                    >
                      <X size={14} /> Cancel
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
