import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import ScheduleCalendar from '@/components/ScheduleCalendar'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export default async function SchedulePage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  // Check schedule permission
  if (user.role !== 'owner' && user.permissions?.schedule === false) {
    redirect('/')
  }

  return (
    <div className="p-8">
      <ScheduleCalendar user={user} />
    </div>
  )
}
