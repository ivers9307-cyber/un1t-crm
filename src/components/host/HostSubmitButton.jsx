'use client'

// HOST-PORTAL.3 — the host's "Publish" action. POSTs the host-scoped submit
// route (HOSTAUTOPUB.1: draft → published, no staff review) then refreshes the
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
        setError(json.error || 'Could not publish')
        setBusy(false)
        return
      }
      router.refresh()
    } catch {
      setError('Could not publish')
      setBusy(false)
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={submit}
        disabled={busy}
        className="text-host-ok hover:opacity-80 disabled:opacity-60"
      >
        {busy ? 'Publishing…' : 'Publish'}
      </button>
      {error && <span className="text-host-bad">{error}</span>}
    </span>
  )
}
