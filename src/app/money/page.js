// /money — Money hub index. Mirrors /members (HUBS.2b). Gate keys mirror
// each PAGE's own gate: /accounting → accounting_hub, /invoices →
// invoices_inbox, /card-receipts → card_receipts, /orders → orders
// (the page ALSO requires a manager role — pre-existing overshow, the tab
// and this chain keep the old sidebar entry's permission-only semantics),
// /offer-sales → approvals_offer_purchases, then the two DEEP.4 Task 1
// reviewer doors into (team) pages, last, matching the tab strip.
//
// HUBDOOR.1 — the chain moved to src/lib/hub-index-chains.js as data so
// nav-items.test.js can prove every key in this hub's sidebar union
// reaches a real surface (Money was already complete; the module is what
// keeps it that way).

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { resolveHubIndexTarget } from '@/lib/hub-index-chains'

export const dynamic = 'force-dynamic'

export default async function MoneyIndexPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  redirect(resolveHubIndexTarget(user, '/money', hasPermission))
}
