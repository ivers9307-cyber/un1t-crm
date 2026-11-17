// LEAVEBAL.1 — Schedule › Leave balances. Every active member of staff at the
// active studio with the year's holiday allowance (days) and time-in-lieu
// balance (hours); a manager edits the allowance and carry-over and keeps the
// lieu ledger from here. The data comes from GET /api/schedule/allowances/team
// and the existing allowance and lieu routes (the page reads nothing itself,
// so no service-role client here). Same gate as the Time Off and Swaps tabs:
// the schedule permission plus a manager-tier role at the active studio; each
// route re-judges.

import { redirect } from 'next/navigation'
import { getCurrentUser, hasRoleAtLocation } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { MANAGER_ROLES } from '@/lib/schemas'
import ScheduleTabs from '@/components/ScheduleTabs'
import LeaveBalancesManager from '@/components/LeaveBalancesManager'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Leave balances' }

export default async function LeaveBalancesPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'schedule')) redirect('/')
  if (!hasRoleAtLocation(user, user.activeLocation?.id, MANAGER_ROLES)) redirect('/schedule')

  return (
    <div className="px-4 py-6 sm:p-8">
      <ScheduleTabs user={user} />
      <h2 className="text-2xl font-bold mb-1">Leave balances</h2>
      <p className="text-sm text-un1t-subtle mb-6 max-w-3xl">
        Holiday allowance is counted in days. Time in lieu is counted in hours: Sundays worked earn it at the
        studio&apos;s Sunday rate and public holidays worked at base time, for employees only. Contractors have
        neither. Pending holiday requests are shown beside the remaining days, not taken off them.
      </p>
      <LeaveBalancesManager />
    </div>
  )
}
