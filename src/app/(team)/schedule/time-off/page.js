import { getCurrentUser } from '@/lib/auth'
import { hasPermission, hasPermissionForLocation } from '@/lib/permissions'
import { APPROVAL_CATEGORY_PERMISSION } from '@shared/permissions'
import { redirect } from 'next/navigation'
import ScheduleTabs from '@/components/ScheduleTabs'
import TimeOffManager from '@/components/TimeOffManager'

export const dynamic = 'force-dynamic'

export default async function TimeOffPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  if (!hasPermission(user, 'schedule')) redirect('/')

  // LEAVE.5 — "approver" is the per-location time-off approval permission at
  // the active studio (the same gate PUT /api/schedule/time-off/[id] applies),
  // not the role alone: approvers see the team first and may record leave
  // for a colleague.
  const canApprove = user.profileRole === 'master' ||
    hasPermissionForLocation(user, user.activeLocation?.id, APPROVAL_CATEGORY_PERMISSION.time_off)

  return (
    <div className="px-4 py-6 sm:p-8">
      {/* SCHED.9 — one of the two real convergence targets for the old
          inline "Approvals" tab (see ScheduleTabs.jsx). */}
      <ScheduleTabs user={user} />
      <TimeOffManager user={user} canApprove={canApprove} />
    </div>
  )
}
