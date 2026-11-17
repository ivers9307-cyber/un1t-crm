'use client'

// INBOXASSIGN.1 — the owner on a queue row, compactly: "You" or a first name.
// Renders nothing for an unowned row, so an unassigned queue stays quiet.

import { UserRound } from 'lucide-react'
import { ownerShortLabel } from '@/lib/inbox-owner'

export default function OwnerTag({ row, userId }) {
  const label = ownerShortLabel(row, userId)
  if (!label) return null
  const mine = label === 'You'
  return (
    <span
      data-testid="owner-tag"
      title={mine ? 'Assigned to you' : (row?.assignee_name ? `Assigned to ${row.assignee_name}` : 'Assigned')}
      className={`inline-flex max-w-[88px] shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
        mine ? 'bg-blue-500/10 text-blue-700' : 'bg-slate-500/10 text-slate-700'
      }`}
    >
      <UserRound size={10} aria-hidden="true" className="shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  )
}
