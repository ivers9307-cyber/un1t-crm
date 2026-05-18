'use client'

// POLICIES.1 — client component for the Acknowledge button.
// POSTs to /api/policies/[slug]/acknowledge, then refreshes the
// server-rendered page so the "acknowledged on" message replaces
// the button. The route is idempotent — repeat clicks are no-ops.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Loader2 } from 'lucide-react'

export default function AcknowledgePolicyButton({ slug, versionNumber }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function handleAck() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/policies/${encodeURIComponent(slug)}/acknowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const j = await res.json()
      if (!j.success) {
        setError(j.error || 'Could not record acknowledgement.')
        setBusy(false)
        return
      }
      // Refresh server-rendered viewer so the success state appears.
      router.refresh()
    } catch (e) {
      setError(e.message || 'Network error.')
      setBusy(false)
    }
  }

  return (
    <div>
      <p className="text-sm text-un1t-light mb-3">
        By clicking below you acknowledge that you have read and understood
        v{versionNumber} of this policy.
      </p>
      <button
        type="button"
        onClick={handleAck}
        disabled={busy}
        className="inline-flex items-center gap-2 bg-un1t-white text-un1t-black px-4 py-2 rounded-md text-sm font-medium hover:bg-un1t-accent disabled:opacity-50"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
        {busy ? 'Recording…' : 'I have read and understood'}
      </button>
      {error && (
        <div className="text-xs text-red-500 mt-2">{error}</div>
      )}
    </div>
  )
}
