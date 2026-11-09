'use client'

// "Email your list" block on an event's Promote tab (HOSTPORTAL.4). Plain data
// in (eventId string, blockedReason string|null, contactCount number|null). Creating the
// draft sends nothing; the composer opens on it.

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function AnnounceEventButton({ eventId, blockedReason, contactCount }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  if (blockedReason) return <p className="text-sm text-white/50">{blockedReason}</p>

  async function create() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/host/events/${eventId}/announce-draft`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success || !json.data?.id) {
        setError(json.error || 'Could not create the draft. Try again.')
        setBusy(false)
        return
      }
      // Stay busy: the page is navigating away.
      router.push(`/host/emails?open=${encodeURIComponent(json.data.id)}&notice=event`)
    } catch {
      setError('Could not create the draft. Try again.')
      setBusy(false)
    }
  }

  return (
    <div>
      {typeof contactCount === 'number' && (
        <p className="text-sm text-white/60">
          {contactCount === 1 ? 'You have 1 contact on your list.' : `You have ${contactCount} contacts on your list.`}
        </p>
      )}
      <button
        type="button"
        onClick={create}
        disabled={busy}
        className="mt-3 rounded-lg bg-white text-black text-sm font-semibold px-4 py-2 hover:bg-white/90 disabled:opacity-50"
      >
        Write an email about this event
      </button>
      <p className="mt-2 text-xs text-white/50">This only creates a draft. Nothing is sent until you send or schedule it.</p>
      {error && <p role="alert" className="mt-2 text-sm text-red-400">{error}</p>}
    </div>
  )
}
