'use client'

// Client component for the per-roster approve button on
// /schedule/approvals. Calls POST /api/schedule/rosters/[id]/approve
// and refreshes on success.
//
// `canApprove` is decided server-side — non-owners get a
// disabled-style button explaining they can't sign off here.

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

  if (!canApprove) {
    return (
      <span className="text-xs text-un1t-subtle italic">
        Owner approval required
      </span>
    )
  }

  return (
    <button
      onClick={handleApprove}
      disabled={busy}
      className="px-3 py-1.5 rounded-md text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50"
    >
      {busy ? 'Approving…' : 'Approve & publish'}
    </button>
  )
}
