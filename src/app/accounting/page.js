// src/app/accounting/page.js
//
// RCOV.P0/P2 — /accounting: the receipt-coverage hub. Master + owner
// only by default (accounting_hub permission, same tier as
// invoices_inbox). Server component does the auth gate + hands the
// active location's display name down; AccountingTabs hosts the
// Coverage / Exceptions / Runs & health panels, each owning its own
// data fetching.
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import AccountingTabs from '@/components/accounting/AccountingTabs'
import HuntInboxesCard from '@/components/accounting/HuntInboxesCard'

export const dynamic = 'force-dynamic'

export default async function AccountingPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login?redirect=/accounting')
  if (!hasPermission(user, 'accounting_hub')) redirect('/dashboard')

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <h1 className="text-xl font-semibold text-un1t-text mb-1">Accounting</h1>
      <p className="text-sm text-un1t-subtle mb-6">
        Receipt coverage — every unreconciled bank transaction, and whether a receipt has been collected for it.
      </p>
      <div className="mb-6">
        <HuntInboxesCard />
      </div>
      <AccountingTabs locationName={user.activeLocation?.name || ''} />
    </div>
  )
}
