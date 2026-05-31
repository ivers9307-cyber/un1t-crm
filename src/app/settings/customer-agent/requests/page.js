'use client'

import { useState, useEffect } from 'react'

// RADAR-AGENT Phase 2 — operator approval queue. Manager+ reviews the
// pause / cancellation requests the customer agent captured, and decides:
// Approve, Decline, or (for cancellations) Save (retention kept them).
// The actual Glofox change is made by staff after approving.

const KIND_LABEL = { pause: 'Pause', cancellation: 'Cancellation' }
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

export default function AgentRequestsPage() {
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState(null)

  async function load() {
    try {
      const res = await fetch('/api/agent/membership-requests').then(r => r.json())
      if (res.success) setRequests(res.requests || [])
      else setError(res.error || 'Failed to load')
    } catch { setError('Failed to load') }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

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
  const decided = requests.filter(r => r.status !== 'pending')

  return (
    <div className="max-w-3xl">
      <h1 className="text-xl font-bold text-un1t-text mb-1">Agent Requests</h1>
      <p className="text-sm text-un1t-muted mb-6">
        Pause &amp; cancellation requests captured by the customer agent. Review and decide —
        the agent never changes a membership itself. After approving, make the change in Glofox.
      </p>

      {error && <div className="text-sm text-red-600 mb-4">{error}</div>}

      {pending.length === 0 && (
        <div className="text-sm text-un1t-muted border border-dashed border-un1t-border rounded-md p-4 mb-6">
          No pending requests. 🎉
        </div>
      )}

      <div className="space-y-3">
        {pending.map(r => (
          <RequestCard key={r.id} r={r} busy={busyId === r.id} onDecide={decide} />
        ))}
      </div>

      {decided.length > 0 && (
        <>
          <h2 className="text-sm font-semibold text-un1t-subtle uppercase tracking-wider mt-8 mb-3">Decided</h2>
          <div className="space-y-2">
            {decided.map(r => (
              <div key={r.id} className="flex items-center justify-between border border-un1t-border rounded-md px-4 py-2 text-sm">
                <span className="text-un1t-text">
                  {KIND_LABEL[r.kind] || r.kind} · {r.contacts?.name || r.contacts?.first_name || 'Unknown'}
                </span>
                <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_STYLE[r.status] || ''}`}>{r.status}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function RequestCard({ r, busy, onDecide }) {
  const name = r.contacts?.name || r.contacts?.first_name || 'Unknown member'
  const d = r.details || {}
  const isCancel = r.kind === 'cancellation'
  return (
    <div className="border border-un1t-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className={`text-xs px-2 py-0.5 rounded-full ${isCancel ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-800'}`}>
            {KIND_LABEL[r.kind] || r.kind}
          </span>
          <span className="text-sm font-medium text-un1t-text">{name}</span>
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
        {d.reason && <p className="text-un1t-muted">Reason: “{d.reason}”</p>}
        {!d.reason && !d.start_date && !d.end_date && !d.desired_date && (
          <p className="text-un1t-muted">No further detail captured.</p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button onClick={() => onDecide(r.id, 'approved')} disabled={busy}
          className="text-sm bg-un1t-text text-un1t-bg px-3 py-1.5 rounded-md font-medium disabled:opacity-50">
          Approve
        </button>
        {isCancel && (
          <button onClick={() => onDecide(r.id, 'saved')} disabled={busy}
            className="text-sm border border-blue-300 text-blue-700 px-3 py-1.5 rounded-md disabled:opacity-50">
            Saved (kept)
          </button>
        )}
        <button onClick={() => onDecide(r.id, 'declined')} disabled={busy}
          className="text-sm border border-un1t-border text-un1t-muted px-3 py-1.5 rounded-md disabled:opacity-50">
          Decline
        </button>
      </div>
    </div>
  )
}
