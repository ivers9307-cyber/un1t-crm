'use client'

// CONTRACTS-DRAFT.1 — owner/master actions on a draft contract:
//   - "Send now"       flips draft -> issued and fires the recipient's
//                       very first notification (POST .../send).
//   - "Discard draft"  revokes it silently — the recipient never knew
//                       it existed, so no email goes out (POST
//                       .../discard). Confirmed with window.confirm,
//                       same convention as ContractRevokeButton.
// Mirrors ContractResendButton/ContractRevokeButton's busy/error
// handling; on success both actions router.refresh() so the detail
// page re-renders with the new status.

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function ContractDraftActions({ contractId }) {
  const router = useRouter()
  const [busy, setBusy] = useState(null) // 'send' | 'discard' | null
  const [error, setError] = useState(null)

  async function handleSend() {
    setBusy('send')
    setError(null)
    try {
      const res = await fetch(`/api/contracts/${contractId}/send`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      router.refresh()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  async function handleDiscard() {
    const ok = window.confirm('Discard this draft? This cannot be undone.')
    if (!ok) return
    setBusy('discard')
    setError(null)
    try {
      const res = await fetch(`/api/contracts/${contractId}/discard`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      router.refresh()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleSend}
          disabled={!!busy}
          className="text-xs bg-un1t-text text-un1t-bg px-3 py-1.5 rounded-md font-medium hover:bg-un1t-accent disabled:opacity-50"
        >{busy === 'send' ? 'Sending…' : 'Send now'}</button>
        <button
          type="button"
          onClick={handleDiscard}
          disabled={!!busy}
          className="text-xs px-3 py-1.5 rounded-md border border-red-500/40 text-red-700 hover:bg-red-500/10 disabled:opacity-50"
        >{busy === 'discard' ? 'Discarding…' : 'Discard draft'}</button>
      </div>
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  )
}
