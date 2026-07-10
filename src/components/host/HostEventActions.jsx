'use client'

// HOST-PORTAL.10 — "Take off sale" / "Delete event" actions on the host event
// detail page. Take off sale = POST unpublish (published → draft; attendees
// keep their tickets, new sales stop, relisting needs re-approval). Delete is
// only offered when the event has ZERO registrations — the API enforces the
// same rule, this just hides a button that would always 409.

import { useState } from 'react'

export default function HostEventActions({ eventId, status, hasRegistrations }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function takeOffSale() {
    if (busy) return
    if (!window.confirm('Take this event off sale? Existing attendees keep their tickets — this only stops new sales. Putting it back on sale needs UN1T approval again.')) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/host/events/${eventId}/unpublish`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) {
        setError(json.error || 'Could not take the event off sale')
        setBusy(false)
        return
      }
      window.location.reload()
    } catch {
      setError('Could not take the event off sale')
      setBusy(false)
    }
  }

  async function deleteEvent() {
    if (busy) return
    if (!window.confirm('Delete this event? This cannot be undone.')) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/host/events/${eventId}`, { method: 'DELETE' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) {
        setError(json.error || 'Could not delete the event')
        setBusy(false)
        return
      }
      window.location.href = '/host'
    } catch {
      setError('Could not delete the event')
      setBusy(false)
    }
  }

  const showOffSale = status === 'published'
  const showDelete = !hasRegistrations
  if (!showOffSale && !showDelete) return null

  return (
    <div className="shrink-0 flex items-center gap-2 flex-wrap">
      {showOffSale && (
        <button
          type="button"
          onClick={takeOffSale}
          disabled={busy}
          className="rounded-lg border border-white/15 text-white/80 text-sm font-medium px-4 py-2 hover:bg-white/5 hover:text-white disabled:opacity-60"
        >
          {busy ? 'Working…' : 'Take off sale'}
        </button>
      )}
      {showDelete && (
        <button
          type="button"
          onClick={deleteEvent}
          disabled={busy}
          className="rounded-lg border border-red-500/30 bg-red-500/10 text-red-300 text-sm font-medium px-4 py-2 hover:bg-red-500/20 hover:text-red-200 disabled:opacity-60"
        >
          {busy ? 'Working…' : 'Delete event'}
        </button>
      )}
      {error && <span className="basis-full text-sm text-red-400">{error}</span>}
    </div>
  )
}
