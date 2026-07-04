// src/app/accounting/page.js
//
// RCOV.P0 — /accounting: the receipt-coverage board. Master + owner
// only by default (accounting_hub permission, same tier as
// invoices_inbox). Server component does the auth gate + hands the
// active location's display name down; CoverageBoard owns all data
// fetching against the two /api/accounting/coverage routes.
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import CoverageBoard from '@/components/accounting/CoverageBoard'

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
      <CoverageBoard locationName={user.activeLocation?.name || ''} />
    </div>
  )
}
