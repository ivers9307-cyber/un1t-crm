// APPROVALS.1 — central approvals dashboard.
//
// Aggregates everything awaiting the operator's review across the
// platform: contractor invoices, FTE expense claims, time-off
// requests, shift swaps. Each tab shows a list with a "Review →"
// link to the existing source page (operators can also visit those
// pages directly — this is an aggregator, not a replacement).
//
// Access (APPROVALS-PERCAT.1): `approvals_inbox` is now a DERIVED
// permission — visible iff the Approvals feature is enabled at the
// active location AND the user holds ≥1 of the six per-category
// approval grants. The registry gates each tab on its own
// permissionKey, so users only see the categories they can approve.
// Default holders: master + owner (all six); manager + head_coach
// (agent requests, time off, shift swaps); staff + reception (none).

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
        <h1 className="text-2xl font-semibold text-un1t-text">Approvals</h1>
        <p className="text-sm text-un1t-subtle mt-1">
          Everything waiting on your review. Agent requests can be approved or declined right here; other items open their source page.
        </p>
      </header>
      <ApprovalsInbox />
    </div>
  )
}
