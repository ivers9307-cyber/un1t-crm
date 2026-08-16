// FTE-EXPENSES.1 — page route for the expense reimbursement flow.
//
// Role-aware via ExpensesManager (which fetches and routes):
//   - FTE employees: see their own claims list + a "New claim" button
//   - Owners at a location: see the review queue for that location
//   - Masters: see everything platform-wide

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { hasPermission } from '@/lib/permissions'
import ScheduleTabs from '@/components/ScheduleTabs'
import ExpensesManager from '@/components/ExpensesManager'

export const dynamic = 'force-dynamic'

export default async function ExpensesPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login?redirect=/schedule/expenses')

  // FTE submitters always have access; owners + masters always have
  // access (review queue). Contractors don't — they use /schedule/invoices.
  //
  // FU-INVOICES-APPROVER — isApprover used to be role-only (master, or
  // owner at ANY location), ignoring the grantable approvals_fte_expenses
  // key that src/lib/approvals/providers/fte-expenses.js and the Money
  // hub's Staff-expenses tab (src/app/(money)/layout.js) both gate on —
  // same bug class as InvoicesManager. hasPermission is OR'd in (not a
  // replace) so master/owner keep access even if their permissions blob
  // is missing/stale; hasPermission reads the ACTIVE location's grant,
  // which is what the Money tab and provider check too.
  const isFte = user.employment_type === 'fte'
  const isApprover = hasPermission(user, 'approvals_fte_expenses')
    || user.profileRole === 'master' || user.role === 'master'
    || Object.values(user.rolesByLocation || {}).some((r) => r === 'owner')
  if (!isFte && !isApprover) redirect('/schedule')

  // Load location list for the new-claim picker. Master sees all,
  // others see only their own. Server-side render so the form
  // doesn't flash empty.
  const db = createServerClient()
  let locations = []
  if (user.profileRole === 'master' || user.role === 'master') {
    const { data } = await db.from('locations').select('id, name').eq('active', true).eq('is_host_anchor', false).order('name')
    locations = data || []
  } else {
    locations = (user.locations || []).map((l) => ({ id: l.id, name: l.name }))
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* SCHED.9 — Schedule tab strip follows onto every sibling page. */}
      <ScheduleTabs user={user} />
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-un1t-text">Expenses</h1>
        <p className="text-sm text-un1t-subtle mt-1">
          {isFte && !isApprover && 'Submit your monthly expense receipts for reimbursement. Approved claims are paid via the next payroll run.'}
          {isApprover && !isFte && 'Review and approve expense claims submitted by your team.'}
          {isFte && isApprover && 'Submit your own expenses and approve your team’s.'}
        </p>
      </header>
      <ExpensesManager
        userId={user.id}
        isFte={isFte}
        isApprover={isApprover}
        locations={locations}
      />
    </div>
  )
}
