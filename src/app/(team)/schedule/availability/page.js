// AVAIL.1 — "My availability": every signed-in staff member's own editor.
// Same gate as the other /schedule/* pages. Today is the Dublin business day
// (the server's rules use the same), passed down so the date pickers and the
// "that date has passed" check agree with the save. No data is read here:
// the editor reads its own rules through GET /api/schedule/availability.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { dublinTodayStr } from '@/lib/dublin-time'
import ScheduleTabs from '@/components/ScheduleTabs'
import AvailabilityEditor from '@/components/AvailabilityEditor'

export const dynamic = 'force-dynamic'

export default async function AvailabilityPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'schedule')) redirect('/')

  return (
    <div className="px-4 py-6 sm:p-8">
      <ScheduleTabs user={user} />
      <AvailabilityEditor todayIso={dublinTodayStr()} />
    </div>
  )
}
