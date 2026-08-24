'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Copy, Check } from 'lucide-react'
import { formatMoneyMinor } from '@/lib/money-format'
import { isStuckExecuting, retryOffered } from '@/lib/agent/request-recovery'
import { whyFlagged, customerWords, failureExplanation } from '@/lib/approvals/agent-request-why'

// RADAR-AGENT Phase 2 — operator approval queue. Manager+ reviews the
// pause / cancellation requests the customer agent captured, and decides:
// Approve, Decline, or (for cancellations) Save (retention kept them).
// The actual Glofox change is made by staff after approving.

const KIND_LABEL = { pause: 'Pause', cancellation: 'Cancellation', class_booking: 'Class booking', consultation: 'Consultation', membership_purchase: 'Membership purchase' }
const STATUS_STYLE = {
  pending: 'bg-amber-100 text-amber-800',
  approved: 'bg-green-100 text-green-700',
  declined: 'bg-gray-200 text-gray-600',
  saved: 'bg-blue-100 text-blue-700',
  actioned: 'bg-green-100 text-green-700',
}

function fmtDate(d) {
  if (!d) return null
  try { return new Date(d).toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' }) }
  catch { return d }
}

export default function AgentRequestsClient() {
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState(null)
  const [focusId, setFocusId] = useState(null)

  async function load() {
    try {
      const res = await fetch('/api/agent/membership-requests').then(r => r.json())
      if (res.success) setRequests(res.requests || [])
      else setError(res.error || 'Failed to load')
    } catch { setError('Failed to load') }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  // Deep-link focus: /approvals links here with ?focus=<requestId>. Read it
  // client-side (avoids a Suspense boundary) and scroll the row into view +
  // highlight it once loaded, so a one-click jump lands on the right request.
  useEffect(() => {
    try { setFocusId(new URLSearchParams(window.location.search).get('focus')) } catch { /* no-op */ }
  }, [])
  useEffect(() => {
    if (!focusId || loading) return
    const el = document.getElementById(`agent-req-${focusId}`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [focusId, loading, requests])

  async function decide(id, status) {
    setBusyId(id)
    try {
      const res = await fetch(`/api/agent/membership-requests/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      const j = await res.json()
      if (j.success) {
        setRequests(rs => rs.map(r => r.id === id ? { ...r, status: j.request.status, decided_at: j.request.decided_at } : r))
      } else setError(j.error || 'Failed to update')
    } catch { setError('Failed to update') }
    finally { setBusyId(null) }
  }

  if (loading) return <div className="p-6 text-sm text-un1t-muted">Loading…</div>

  const pending = requests.filter(r => r.status === 'pending')
  // MIA-REVIEW.3 — approvals whose execution crashed mid-flight (claimed as
  // 'approved', never actioned or failed). They used to be invisible and
  // unrecoverable: the customer was told the team would confirm and nothing
  // was ever booked. Approving again retries the execution.
  const stuck = requests.filter(r => isStuckExecuting(r, Date.now()))
  // AGENT-RETRY.1 — failed executions whose retry still makes sense (class
  // not started yet, or failed recently) get their own actionable section
  // instead of dying silently in the Decided list.
  const failedRetryable = requests.filter(r => retryOffered(r, Date.now()))
  const liftedIds = new Set([...stuck, ...failedRetryable].map(r => r.id))
  const decided = requests.filter(r => r.status !== 'pending' && !liftedIds.has(r.id))

  return (
    <div className="max-w-3xl">
      <h1 className="text-xl font-bold text-un1t-text mb-1">Agent Requests</h1>
      <p className="text-sm text-un1t-muted mb-6">
        Requests from the customer agent and booking flows. Review and decide — approving a
        class booking completes it automatically; for pause/cancellation, make the change in
        Glofox after approving.
      </p>

      {error && <div className="text-sm text-red-600 mb-4">{error}</div>}

      {pending.length === 0 && (
        <div className="text-sm text-un1t-muted border border-dashed border-un1t-border rounded-md p-4 mb-6">
          No pending requests. 🎉
        </div>
      )}

      {stuck.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-amber-700 uppercase tracking-wider mb-2">Needs a retry</h2>
          <p className="text-xs text-un1t-muted mb-3">
            These were approved but the booking never completed (the request timed out or crashed
            part-way). The customer has not been confirmed. Approve again to re-run it.
          </p>
          <div className="space-y-3">
            {stuck.map(r => (
              <RequestCard key={r.id} r={r} busy={busyId === r.id} onDecide={decide} focused={r.id === focusId} />
            ))}
          </div>
        </div>
      )}

      {failedRetryable.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-red-700 uppercase tracking-wider mb-2">Failed — fix &amp; retry</h2>
          <p className="text-xs text-un1t-muted mb-3">
            These were approved but Glofox rejected the action, so the customer has NOT been
            confirmed. Fix the problem in Glofox (the card says what went wrong), then retry.
          </p>
          <div className="space-y-3">
            {failedRetryable.map(r => (
              <RequestCard key={r.id} r={r} busy={busyId === r.id} onDecide={decide} focused={r.id === focusId} retryMode />
            ))}
          </div>
        </div>
      )}

      <div className="space-y-3">
        {pending.map(r => (
          <RequestCard key={r.id} r={r} busy={busyId === r.id} onDecide={decide} focused={r.id === focusId} />
        ))}
      </div>

      {decided.length > 0 && (
        <>
          <h2 className="text-sm font-semibold text-un1t-subtle uppercase tracking-wider mt-8 mb-3">Decided</h2>
          <div className="space-y-2">
            {decided.map(r => (
              <div key={r.id} id={`agent-req-${r.id}`} className={`flex items-center justify-between border rounded-md px-4 py-2 text-sm ${r.id === focusId ? 'border-un1t-text ring-2 ring-un1t-text/30' : 'border-un1t-border'}`}>
                <span className="text-un1t-text">
                  {KIND_LABEL[r.kind] || r.kind} · {r.contacts?.name || r.contacts?.first_name || 'Unknown'}
                </span>
                <div className="flex items-center gap-3">
                  {r.conversation_id && (
                    <Link
                      href={`/communications/inbox?c=${r.conversation_id}&ch=${r.channel === 'instagram' ? 'ig' : 'wa'}`}
                      className="text-xs text-un1t-muted underline hover:text-un1t-text"
                    >
                      Open conversation
                    </Link>
                  )}
                  <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_STYLE[r.status] || ''}`}>{r.status}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// AGENT-REQ-UX.1 — click-to-copy contact detail for the Glofox lookup.
function CopyValue({ value }) {
  const [copied, setCopied] = useState(false)
  if (!value) return null
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch { /* clipboard unavailable — the value is still visible to select */ }
      }}
      title="Copy"
      className="inline-flex items-center gap-1 text-xs text-un1t-text bg-un1t-bg border border-un1t-border rounded-md px-2 py-0.5 hover:bg-un1t-border/30"
    >
      <span className="select-all">{value}</span>
      {copied ? <Check size={12} className="text-green-700" /> : <Copy size={12} className="text-un1t-subtle" />}
    </button>
  )
}

function RequestCard({ r, busy, onDecide, focused = false, retryMode = false }) {
  const name = r.contacts?.name || r.contacts?.first_name || 'Unknown member'
  const d = r.details || {}
  const isCancel = r.kind === 'cancellation'
  // AGENT-REQ-UX.1 — machine flag codes (class bookings) become operator
  // copy; the customer's own words render as a quote, never as a code.
  const why = whyFlagged(r)
  const said = customerWords(r)
  // AGENT-RETRY.1 — what Glofox rejected and what to fix before retrying.
  const failWhy = retryMode ? failureExplanation(r) : null
  return (
    <div id={`agent-req-${r.id}`} className={`border rounded-lg p-4 ${focused ? 'border-un1t-text ring-2 ring-un1t-text/30' : 'border-un1t-border'}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className={`text-xs px-2 py-0.5 rounded-full ${isCancel ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-800'}`}>
            {KIND_LABEL[r.kind] || r.kind}
          </span>
          <span className="text-sm font-medium text-un1t-text">{name}</span>
          {d.paid && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-700">
              Paid {formatMoneyMinor(d.amount_cents, d.currency)}
            </span>
          )}
          {r.channel && <span className="text-xs text-un1t-muted">· via {r.channel}</span>}
          {isCancel && r.retention_flagged && <span className="text-xs text-blue-600">· retention</span>}
        </div>
        <span className="text-xs text-un1t-muted">{fmtDate(r.created_at)}</span>
      </div>

      <div className="text-xs text-un1t-subtle space-y-0.5 mb-3">
        {r.kind === 'pause' && (d.start_date || d.end_date) && (
          <p>{d.start_date ? `From ${fmtDate(d.start_date)}` : ''}{d.end_date ? ` to ${fmtDate(d.end_date)}` : ''}</p>
        )}
        {isCancel && d.desired_date && <p>Requested date: {fmtDate(d.desired_date)}</p>}
        {(r.kind === 'class_booking' || r.kind === 'consultation') && (d.class_name || d.class_time) && (
          <p>{d.class_name || (r.kind === 'consultation' ? 'Consultation' : 'Class')}{d.class_time ? ` · ${d.class_time}` : ''}</p>
        )}
        {failWhy && (
          <p className="text-red-700">
            <span className="font-semibold">What went wrong:</span> {failWhy}
          </p>
        )}
        {why && (
          <p className="text-un1t-muted">
            <span className="font-semibold text-un1t-text">Why it needs review:</span> {why}
          </p>
        )}
        {said && (
          <p className="text-un1t-muted border-l-2 border-un1t-border pl-2">
            <span className="font-semibold text-un1t-text">Customer said:</span> “{said}”
          </p>
        )}
        {!why && !said && !d.start_date && !d.end_date && !d.desired_date && !d.class_name && !d.class_time && (
          <p className="text-un1t-muted">No further detail captured.</p>
        )}
        {(r.contacts?.email || r.contacts?.phone) && (
          <div className="flex items-center gap-2 flex-wrap pt-1">
            <span className="text-[10px] uppercase tracking-wide text-un1t-subtle">Glofox lookup</span>
            <CopyValue value={r.contacts?.email} />
            <CopyValue value={r.contacts?.phone} />
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button onClick={() => onDecide(r.id, 'approved')} disabled={busy}
          className="text-sm bg-un1t-text text-un1t-bg px-3 py-1.5 rounded-md font-medium disabled:opacity-50">
          {retryMode ? 'Fixed it — retry' : 'Approve'}
        </button>
        {!retryMode && isCancel && (
          <button onClick={() => onDecide(r.id, 'saved')} disabled={busy}
            className="text-sm border border-blue-300 text-blue-700 px-3 py-1.5 rounded-md disabled:opacity-50">
            Saved (kept)
          </button>
        )}
        {/* Decline on a failed row would 409 (the claim is pending-only) —
            retry mode offers only the retry. */}
        {!retryMode && (
          <button onClick={() => onDecide(r.id, 'declined')} disabled={busy}
            className="text-sm border border-un1t-border text-un1t-muted px-3 py-1.5 rounded-md disabled:opacity-50">
            Decline
          </button>
        )}
        {r.conversation_id && (
          <Link
            href={`/communications/inbox?c=${r.conversation_id}&ch=${r.channel === 'instagram' ? 'ig' : 'wa'}`}
            className="text-xs text-un1t-muted underline hover:text-un1t-text ml-1"
          >
            Open conversation
          </Link>
        )}
      </div>
    </div>
  )
}
