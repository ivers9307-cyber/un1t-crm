'use client'

// APPROVALSQ.4 — a shift swap decided on /approvals. The route refuses an
// approval that would put someone on leave or on a clashing shift with a 409
// whose body is { code: 'swap_conflicts', conflicts: [{ message }] }. That is
// the approver's call, not a dead end: list the conflicts and offer "Approve
// anyway" (the same approval re-sent with confirm_conflicts: true) or "Back".
import { useState } from 'react'
import { Button } from '@/components/ui'
import { approveSwapAnyway } from '@/lib/approvals/team-actions'
import TeamDecideCard from './TeamDecideCard'

const SWAP_CONFLICTS_CODE = 'swap_conflicts'

function ConflictStep({ item, result, controls }) {
  const [busy, setBusy] = useState(false)
  const messages = (result.body?.conflicts || []).map((c) => c?.message).filter(Boolean)
  const lines = messages.length ? messages : [result.error || 'This swap has a conflict.']

  async function anyway() {
    setBusy(true)
    try { await controls.approveAgain(() => approveSwapAnyway(item)) } finally { setBusy(false) }
  }

  return (
    <div role="alert" className="w-full rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 space-y-2">
      <div className="font-medium">Check before approving</div>
      <ul className="list-disc pl-5 space-y-0.5">
        {lines.map((m, i) => <li key={i}>{m}</li>)}
      </ul>
      <div className="flex gap-2 flex-wrap">
        <Button type="button" size="sm" variant="primary" loading={busy} disabled={busy} onClick={anyway}>Approve anyway</Button>
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={controls.dismiss}>Back</Button>
      </div>
    </div>
  )
}

export default function ShiftSwapCard({ item, ...rest }) {
  return (
    <TeamDecideCard
      item={item}
      providerKey="shift_swaps"
      {...rest}
      onApproveFailure={(result, controls) => (
        result?.status === 409 && result?.body?.code === SWAP_CONFLICTS_CODE
          ? <ConflictStep item={item} result={result} controls={controls} />
          : null
      )}
    />
  )
}
