'use client'

// HOST-PORTAL.3 — "Submit for review" action on the host dashboard. POSTs the
// host-scoped submit route (draft/rejected → pending_review) then refreshes the
// server-rendered row so the new status chip shows immediately.

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function HostSubmitButton({ eventId }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function submit() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/host/events/${eventId}/submit`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) {
        setError(json.error || 'Could not submit')
        setBusy(false)
        return
      }
      router.refresh()
    } catch {
      setError('Could not submit')
      setBusy(false)
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={submit}
        disabled={busy}
        className="text-emerald-300/90 hover:text-emerald-200 disabled:opacity-60"
      >
        {busy ? 'Submitting…' : 'Submit for review'}
      </button>
      {error && <span className="text-red-400">{error}</span>}
    </span>
  )
}
