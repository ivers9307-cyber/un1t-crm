// APPROVALS.1 — central approvals dashboard.
//
// Aggregates everything awaiting the operator's review across the
// platform: contractor invoices, FTE expense claims, time-off
// requests, shift swaps. Each tab shows a list with a "Review →"
// link to the existing source page (operators can also visit those
// pages directly — this is an aggregator, not a replacement).
//
// Access: anyone with the `approvals_inbox` permission. Defaults:
// master, owner, manager ON; head_coach + staff OFF. Per-provider
// scoping inside the API ensures users only see items they can
// actually approve.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import ApprovalsInbox from '@/components/ApprovalsInbox'

export const dynamic = 'force-dynamic'

export default async function ApprovalsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login?redirect=/approvals')
  if (!hasPermission(user, 'approvals_inbox')) redirect('/dashboard')

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-un1t-white">Approvals</h1>
        <p className="text-sm text-un1t-light mt-1">
          Everything waiting on your review. Click an item to open the source page and approve or decline.
        </p>
      </header>
      <ApprovalsInbox />
    </div>
  )
}
