// /money — Money hub index. Mirrors /members (HUBS.2b). Gate keys mirror
// each PAGE's own gate: /accounting → accounting_hub, /invoices →
// invoices_inbox, /card-receipts → card_receipts, /orders → orders
// (the page ALSO requires a manager role — pre-existing overshow, the tab
// and this chain keep the old sidebar entry's permission-only semantics),
// /offer-sales → approvals_offer_purchases.
//
// DEEP.4 Task 1 (4A) — /schedule/invoices → approvals_contractor_invoices
// and /schedule/expenses → approvals_fte_expenses join the chain AFTER
// approvals_offer_purchases, LAST (mirrors the tab order in
// (money)/layout.js: contractor-invoices and expenses are the final two
// tabs). Both targets are (team)-group pages reached only by this hub's
// reviewer door — submitters reach them via Team → Schedule instead,
// never via /money.
//
// DEEP.4 final review — originally placed BEFORE approvals_offer_purchases,
// which put an offers+contractor approver's redirect out of tab order and
// bounced them to /schedule/invoices (Team chrome) instead of landing
// in-hub at /offer-sales. Moved to match the tab strip exactly.

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
  if (hasPermission(user, 'approvals_contractor_invoices')) redirect('/schedule/invoices')
  if (hasPermission(user, 'approvals_fte_expenses')) redirect('/schedule/expenses')
  redirect('/')
}
