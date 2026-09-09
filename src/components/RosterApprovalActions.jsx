'use client'

// Client component for the per-roster approve / reject buttons on
// /schedule/approvals. Calls POST /api/schedule/rosters/[id]/approve or
// .../reject and refreshes on success.
//
// `canApprove` is decided server-side — non-owners get a
// disabled-style button explaining they can't sign off here. The same
// flag gates Reject: approving and rejecting are the same decision.

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function RosterApprovalActions({ rosterId, canApprove }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function handleApprove() {
    if (!confirm('Approve this roster? Staff will see their shifts as soon as you confirm.')) return
    setBusy(true)
    try {
      const res = await fetch(`/api/schedule/rosters/${rosterId}/approve`, { method: 'POST' })
      const data = await res.json()
      if (!data.success) {
        alert(data.error || 'Approval failed')
        return
      }
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  // ROSTER-FIX.4 — D5: rejecting DELETES the draft, so the confirm has to
  // say so plainly. The note is optional and goes to the manager who
  // submitted it; cancelling the prompt still rejects (prompt() returns
  // null), because the operator already confirmed the destructive part.
  async function handleReject() {
    if (!confirm('Reject this roster? The draft is deleted and the manager will be told to adjust and publish again.')) return
    const note = prompt('Why? (optional — the manager sees this)')
    setBusy(true)
    try {
      const res = await fetch(`/api/schedule/rosters/${rosterId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: note || null }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        alert(data.error || 'Rejection failed')
        return
      }
      router.refresh()
    } catch {
      alert('Network error — the roster was not rejected.')
    } finally {
      setBusy(false)
    }
  }

  if (!canApprove) {
    return (
      <span className="text-xs text-un1t-subtle italic">
        Owner approval required
      </span>
    )
  }

  return (
    <div className="flex items-center gap-2 shrink-0">
      <button
        onClick={handleReject}
        disabled={busy}
        className="px-3 py-1.5 rounded-md text-xs font-medium border border-un1t-border text-un1t-subtle hover:text-red-700 hover:border-red-700 disabled:opacity-50"
      >
        Reject
      </button>
      <button
        onClick={handleApprove}
        disabled={busy}
        className="px-3 py-1.5 rounded-md text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50"
      >
        {busy ? 'Approving…' : 'Approve & publish'}
      </button>
    </div>
  )
}
