import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { redirect } from 'next/navigation'
import ScheduleTabs from '@/components/ScheduleTabs'
import TimeOffManager from '@/components/TimeOffManager'

export const dynamic = 'force-dynamic'

export default async function TimeOffPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  if (!hasPermission(user, 'schedule')) redirect('/')

  return (
    <div className="p-8">
      {/* SCHED.9 — one of the two real convergence targets for the old
          inline "Approvals" tab (see ScheduleTabs.jsx). */}
      <ScheduleTabs user={user} />
      <TimeOffManager user={user} />
    </div>
  )
}
