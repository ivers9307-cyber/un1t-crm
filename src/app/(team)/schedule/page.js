import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { redirect } from 'next/navigation'
import ScheduleTabs from '@/components/ScheduleTabs'
import ScheduleRosterView from '@/components/ScheduleRosterView'
import ScheduleReporting from '@/components/ScheduleReporting'
import { MANAGER_ROLES } from '@/lib/schemas'

export const dynamic = 'force-dynamic'

// SCHED.9 — Reporting has no standalone sibling page (unlike Approvals/
// Attendance/Expenses/Invoices/Time Off/Swaps, it only ever rendered
// inline), so there's nothing to converge it onto. It stays here on the
// /schedule root, but distinguished by a real, shareable ?view=reporting
// search param rather than local state — ScheduleTabs links to
// /schedule?view=reporting and this page reads it server-side. A
// non-manager who guesses the query param still just gets the roster
// (same population that never sees the Reporting tab at all).
export default async function SchedulePage({ searchParams }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  if (!hasPermission(user, 'schedule')) redirect('/')

  const params = (await searchParams) || {}
  const showReporting = params.view === 'reporting' && MANAGER_ROLES.includes(user.role)

  return (
    <div className="p-8">
      <ScheduleTabs user={user} />
      {showReporting
        ? <ScheduleReporting user={user} />
        : <ScheduleRosterView user={user} />}
    </div>
  )
}
