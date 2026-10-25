import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { redirect } from 'next/navigation'
import ScheduleTabs from '@/components/ScheduleTabs'
import ScheduleRosterView from '@/components/ScheduleRosterView'
import ScheduleReporting from '@/components/ScheduleReporting'
import { MANAGER_ROLES } from '@/lib/schemas'

export const dynamic = 'force-dynamic'

// ROSTERLOOK.1 — the tab read "UN1T Hatch Street" with the Stillorgan roster on
// screen, because the root layout's title is one site name for everyone.
// TABTITLE.1 moved the studio half of that fix up into (team)/layout.js, where
// it covers every staff page: that layout's title.template appends the ACTIVE
// studio, so this page only names itself and the tab still reads
// "Schedule · UN1T Stillorgan" (or the bare "Schedule" with no active studio,
// exactly as before). The template reaches this page because it sits in a
// CHILD segment of the layout; pinned in src/lib/staff-tab-title.test.js.
export const metadata = { title: 'Schedule' }

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
    <div className="px-4 py-6 sm:p-8">
      <ScheduleTabs user={user} />
      {showReporting
        ? <ScheduleReporting user={user} />
        : <ScheduleRosterView user={user} />}
    </div>
  )
}
