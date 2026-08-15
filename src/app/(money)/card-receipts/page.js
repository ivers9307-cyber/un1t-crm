// /card-receipts — SPEND.P3 company-card receipts.
//
// Standalone per-receipt spend flow. Company-card receipts ride the
// emailed-invoice path: the submitter only provides the receipt PHOTO
// (+ optional "which card" last-4 + note); the bookkeeper's OCR fills
// amount / merchant / date / VAT downstream in /invoices. No owner
// approval, no typed financial fields — `CardReceiptsManager` is a plain
// submitter surface (submit form + the caller's own receipts list).
//
// Access: the `card_receipts` permission gates entry. Anyone without it
// is bounced to / — the API routes enforce the same rules server-side.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import CardReceiptsManager from '@/components/CardReceiptsManager'

export const dynamic = 'force-dynamic'

export default async function CardReceiptsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login?redirect=/card-receipts')
  if (!hasPermission(user, 'card_receipts')) redirect('/')

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <CardReceiptsManager />
    </div>
  )
}
