'use client'

// HOST-PORTAL.3 — staff review queue for host self-serve events.
//
// Client component mounted on /settings/hosts. On mount it fetches the org's
// host events awaiting review (GET /api/hosts/pending-events) and lets a
// Manager+ approve (→ published) or reject (→ rejected + reason) each one via
// POST /api/events/[id]/review. Built on the shared components/ui primitives;
// the section header count doubles as the "pending review" badge.

import { useState, useEffect, useCallback } from 'react'
import { Clock, MapPin, Calendar, Users, Check, X, AlertTriangle } from 'lucide-react'
import { Button, Card, Loading } from '@/components/ui'

function fmtEuro(cents, currency = 'EUR') {
  const n = Number(cents)
  const safe = Number.isFinite(n) ? n : 0
  try {
    return new Intl.NumberFormat('en-IE', { style: 'currency', currency: currency || 'EUR' }).format(safe / 100)
  } catch {
    return `€${(safe / 100).toFixed(2)}`
  }
}

// The event's waves are joined unordered — surface the earliest one so the
// operator sees the first start time + its capacity at a glance.
function firstWave(waves) {
  if (!Array.isArray(waves) || waves.length === 0) return null
  return [...waves].sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''))[0]
}

function ReviewItem({ event, onReviewed }) {
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(null) // 'approve' | 'reject' | null
  const [error, setError] = useState(null)

  const wave = firstWave(event.race_waves)

  async function submit(action, body) {
    if (busy) return
    setBusy(action)
    setError(null)
    try {
      const res = await fetch(`/api/events/${event.id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`)
      onReviewed(event.id)
    } catch (e) {
      setError(e.message || 'Something went wrong')
      setBusy(null)
    }
  }

  function approve() {
    submit('approve', { action: 'approve' })
  }

  function confirmReject() {
    if (!reason.trim()) {
      setError('A reason is required to reject.')
      return
    }
    submit('reject', { action: 'reject', reason: reason.trim() })
  }

  return (
    <div className="rounded-lg border border-un1t-border bg-un1t-bg p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-un1t-text">{event.name || 'Untitled event'}</p>
          <p className="mt-0.5 text-xs text-un1t-subtle">by {event.host_name}</p>
        </div>
        <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-700 shrink-0">
          Pending review
        </span>
      </div>

      <div className="mt-3 grid gap-2 text-xs text-un1t-subtle sm:grid-cols-2">
        <span className="inline-flex items-center gap-1.5">
          <Calendar size={13} className="text-un1t-muted shrink-0" />
          {event.race_date || 'No date set'}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <MapPin size={13} className="text-un1t-muted shrink-0" />
          <span className="truncate">{event.venue_name || 'No venue'}</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="text-un1t-muted">Price</span>
          {fmtEuro(event.non_member_fee_cents)}
        </span>
        {wave && (
          <span className="inline-flex items-center gap-1.5">
            <Clock size={13} className="text-un1t-muted shrink-0" />
            {(wave.start_time || '').slice(0, 5) || '—'}
            <Users size={13} className="text-un1t-muted shrink-0 ml-1" />
            {wave.capacity ?? '—'}
          </span>
        )}
      </div>

      {event.description && (
        <p className="mt-3 line-clamp-3 text-xs text-un1t-muted">{event.description}</p>
      )}

      {error && (
        <p className="mt-3 text-xs text-stage-lost flex items-center gap-1">
          <AlertTriangle size={12} /> {error}
        </p>
      )}

      {rejecting ? (
        <div className="mt-3 space-y-2">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="Tell the host why (they'll see this)…"
            className="w-full rounded-lg border border-un1t-border bg-un1t-bg px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="danger"
              size="sm"
              icon={X}
              loading={busy === 'reject'}
              onClick={confirmReject}
              disabled={!reason.trim()}
            >
              Confirm reject
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => { setRejecting(false); setReason(''); setError(null) }}
              disabled={busy === 'reject'}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            icon={Check}
            loading={busy === 'approve'}
            onClick={approve}
          >
            Approve &amp; publish
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            icon={X}
            onClick={() => { setRejecting(true); setError(null) }}
            disabled={!!busy}
          >
            Reject
          </Button>
        </div>
      )}
    </div>
  )
}

export default function HostEventReviewQueue() {
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch('/api/hosts/pending-events')
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`)
      setEvents(Array.isArray(j.data) ? j.data : [])
    } catch (e) {
      setLoadError(e.message || 'Failed to load pending events')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Drop the reviewed event from the list — its badge count falls with it.
  const removeEvent = useCallback((id) => {
    setEvents((prev) => prev.filter((e) => e.id !== id))
  }, [])

  const title = loading ? 'Pending review' : `Pending review (${events.length})`

  return (
    <Card title={title}>
      {loading ? (
        <Loading label="Loading pending events…" />
      ) : loadError ? (
        <div className="py-4 text-center">
          <p className="text-sm text-stage-lost flex items-center justify-center gap-1">
            <AlertTriangle size={12} /> {loadError}
          </p>
          <Button variant="secondary" size="sm" onClick={load} className="mt-3">Retry</Button>
        </div>
      ) : events.length === 0 ? (
        <p className="text-sm text-un1t-muted">No events awaiting review.</p>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-un1t-subtle">
            Host-submitted events waiting on your approval before they go live.
          </p>
          {events.map((e) => (
            <ReviewItem key={e.id} event={e} onReviewed={removeEvent} />
          ))}
        </div>
      )}
    </Card>
  )
}
