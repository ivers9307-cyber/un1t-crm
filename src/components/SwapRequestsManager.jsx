'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { ArrowLeft, ArrowLeftRight, Check, X, AlertCircle } from 'lucide-react'
import { MANAGER_ROLES } from '@/lib/schemas'

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

export default function SwapRequestsManager({ user }) {
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('review')
  const [actingId, setActingId] = useState(null)
  const searchParams = useSearchParams()
  const focusId = searchParams.get('focus')
  const locationId = user.activeLocation?.id
  const isManager = canManage(user.role)

  // Fetch every swap for the location once and filter client-side. Volume is
  // low (the approvals provider caps at 50), and the previous server-side
  // ?status=pending filter silently hid awaiting_approval rows — the reason a
  // claimed swap drilled in from /approvals showed an empty list.
  const fetchRequests = useCallback(async () => {
    if (!locationId) return
    setLoading(true)
    const res = await fetch(`/api/schedule/swaps?location_id=${locationId}`)
    const data = await res.json()
    setRequests(data.data || [])
    setLoading(false)
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
    setActingId(id)
    const res = await fetch(`/api/schedule/swaps/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, review_note: note }),
    })
    const data = await res.json().catch(() => ({}))
    setActingId(null)
    if (!data.success) {
      alert(`Could not ${status === 'approved' ? 'approve' : status === 'rejected' ? 'reject' : 'update'}: ${data.error || 'Unknown error'}`)
      return
    }
    fetchRequests()
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
                    <div className="text-sm">
                      <span className="text-un1t-subtle">Wants to swap: </span>
                      <span className="font-medium" style={{ color: reqTmpl.color }}>
                        {reqTmpl.name}
                      </span>
                      {reqShift && (
                        <span className="text-un1t-subtle">
                          {' '} on {formatDate(reqShift.shift_date)} ({formatTime(reqShift.start_time_override || reqTmpl.start_time)}–{formatTime(reqShift.end_time_override || reqTmpl.end_time)})
                        </span>
                      )}
                    </div>

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

                    {!tgtShift && (
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
