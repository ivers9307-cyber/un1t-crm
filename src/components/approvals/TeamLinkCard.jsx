'use client'

// APPROVALSQ.4 — a team-and-money item that is NOT decided on /approvals
// (invoices queue, rosters, issues, hyrox sessions: each needs what only its own
// page shows). Same card layout as the decide cards, one Open button, no actions.
import Link from 'next/link'
import { Button } from '@/components/ui'
import CustomerCardShell from './CustomerCardShell'
import { formatApprovalDateTime } from './format-date-time'
import { formatAmount } from './format-amount'

export default function TeamLinkCard({ item, providerLabel, timezone = null }) {
  return (
    <CustomerCardShell
      source={providerLabel}
      name={item.title}
      meta={item.meta}
      when={`Submitted ${formatApprovalDateTime(item.submittedAt, timezone)}`}
      amount={formatAmount(item.amount, item.currency)}
      summary={item.subtitle}
      actions={item.reviewUrl && (
        <Button as={Link} href={item.reviewUrl} size="sm" variant="primary">Open</Button>
      )}
    >
      {item.warning && <div className="text-xs rounded-md px-3 py-2 bg-amber-500/10 text-amber-700">{item.warning}</div>}
    </CustomerCardShell>
  )
}
