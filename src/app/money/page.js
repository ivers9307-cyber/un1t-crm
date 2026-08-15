// /money — Money hub index. Mirrors /members (HUBS.2b). Gate keys mirror
// each PAGE's own gate: /accounting → accounting_hub, /invoices →
// invoices_inbox, /card-receipts → card_receipts, /orders → orders
// (the page ALSO requires a manager role — pre-existing overshow, the tab
// and this chain keep the old sidebar entry's permission-only semantics),
// /offer-sales → approvals_offer_purchases.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

export default async function MoneyIndexPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (hasPermission(user, 'accounting_hub')) redirect('/accounting')
  if (hasPermission(user, 'invoices_inbox')) redirect('/invoices')
  if (hasPermission(user, 'card_receipts')) redirect('/card-receipts')
  if (hasPermission(user, 'orders')) redirect('/orders')
  if (hasPermission(user, 'approvals_offer_purchases')) redirect('/offer-sales')
  redirect('/')
}
