'use client'

// Owner/master-side "Resend email" affordance on the contract detail
// page — POSTs to /api/contracts/[id]/resend. Unlike Revoke this
// never mutates the contract row (a pure notification replay) so it
// skips the confirmation step and router.refresh(); a failed resend
// email surfaces inline exactly like the original issue-time warning
// (see ContractIssueWarningBanner) instead of vanishing silently.

import { useState } from 'react'

export default function ContractResendButton({ contractId }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null) // { warning: string|null } once sent

  async function handleResend() {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch(`/api/contracts/${contractId}/resend`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      setResult({ warning: json.warning || null })
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={handleResend}
        disabled={busy}
        className="text-xs px-3 py-1.5 rounded-md border border-un1t-border text-un1t-subtle hover:text-un1t-text disabled:opacity-50"
      >{busy ? 'Sending…' : 'Resend email'}</button>
      {error && <p className="text-xs text-red-700">{error}</p>}
      {result && !result.warning && <p className="text-xs text-emerald-700">Email resent.</p>}
      {result?.warning && <p className="text-xs text-amber-700">{result.warning}</p>}
    </div>
  )
}
