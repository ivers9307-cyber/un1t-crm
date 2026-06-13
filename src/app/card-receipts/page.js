// /card-receipts — SPEND.P3 company-card receipts.
//
// Standalone per-receipt spend flow (not batched into monthly claims).
// Role-aware via CardReceiptsManager:
//   - Card holders (the `card_receipts` permission): submit form + their
//     own submissions list.
//   - Owner / master: the review queue for their active location, with
//     status tabs + Approve / Decline.
// A user can be both (an owner who holds a company card) — they get the
// form AND the queue.
//
// Access: the `card_receipts` permission gates entry. Owners + master
// hold it by default (they're also the approvers); other roles only if
// an owner grants it per-user. Anyone without it is bounced to / — the
// list/approve API routes enforce the same rules server-side.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import CardReceiptsManager from '@/components/CardReceiptsManager'

export const dynamic = 'force-dynamic'

export default async function CardReceiptsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login?redirect=/card-receipts')
  if (!hasPermission(user, 'card_receipts')) redirect('/')

  // Owner-at-any-location or master get the approver queue view. The
  // GET /api/card-receipts endpoint scopes the queue to the active
  // location for owners (and lets master override) — we just tell the
  // manager which surface to render.
  const isApproverView = user.role === 'master' || user.role === 'owner'

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <CardReceiptsManager
        canSubmit
        isApproverView={isApproverView}
      />
    </div>
  )
}
