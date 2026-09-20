import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { redirect } from 'next/navigation'
import ScheduleTabs from '@/components/ScheduleTabs'
import ScheduleRosterView from '@/components/ScheduleRosterView'
import ScheduleReporting from '@/components/ScheduleReporting'
import { MANAGER_ROLES } from '@/lib/schemas'

export const dynamic = 'force-dynamic'

// ROSTERLOOK.1 — without this the tab shows the root layout's default, which is
// the FIRST company_settings.company_name by location_id for every user
// (src/lib/default-site-name.js): "UN1T Hatch Street" on the Stillorgan roster.
// getCurrentUser is React.cache()'d, so this shares the page's own read. A
// title is never worth a 500: any failure falls back to the page name.
export async function generateMetadata() {
  try {
    const user = await getCurrentUser()
    const studio = user?.activeLocation?.name
    return { title: studio ? `Schedule · ${studio}` : 'Schedule' }
  } catch {
    return { title: 'Schedule' }
  }
}

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
