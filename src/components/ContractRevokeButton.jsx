'use client'

// Master/owner-side "Revoke" affordance on the contract detail
// page. Inline confirmation captures the reason then POSTs to
// /api/contracts/[id]/revoke. Recipient gets an email about the
// withdrawal automatically.

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function ContractRevokeButton({ contractId }) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="text-xs px-3 py-1.5 rounded-md border border-red-500/40 text-red-700 hover:bg-red-500/10"
      >Revoke</button>
    )
  }

  async function handleRevoke() {
    if (!reason.trim()) {
      setError('Reason is required.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/contracts/${contractId}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revoked_reason: reason.trim() }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      router.refresh()
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 bg-red-500/5 border border-red-500/30 rounded-md px-3 py-2">
      <input
        type="text"
        value={reason}
        onChange={e => setReason(e.target.value)}
        placeholder="Reason (required)"
        className="flex-1 min-w-[180px] bg-un1t-bg border border-un1t-border rounded px-2 py-1 text-xs"
      />
      <button
        type="button"
        onClick={() => { setConfirming(false); setReason(''); setError(null) }}
        className="text-xs px-2 py-1 rounded text-un1t-subtle"
      >Cancel</button>
      <button
        type="button"
        onClick={handleRevoke}
        disabled={busy}
        className="text-xs bg-red-600 text-white px-3 py-1 rounded font-medium disabled:opacity-50"
      >{busy ? 'Revoking…' : 'Confirm revoke'}</button>
      {error && <span className="text-xs text-red-700 w-full">{error}</span>}
    </div>
  )
}
