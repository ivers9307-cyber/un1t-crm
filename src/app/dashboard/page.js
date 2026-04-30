// /dashboard — entry. Redirects to the most-aggregated sub-view the
// user has permission for. If none, a "no dashboards available" stub
// rendered inside the dashboard layout (which itself sits inside the
// root AppShell).

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export default async function DashboardIndex() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const perms = user.permissions || {}
  const isOwner = user.role === 'owner'

  // Owner lands on Business; manager on Studio; staff on Today.
  if (isOwner || perms.dashboard_business) redirect('/dashboard/business')
  if (perms.dashboard_studio)              redirect('/dashboard/studio')
  if (perms.dashboard_personal)            redirect('/dashboard/today')

  // Falls back to the layout's chrome (header + segmented control)
  // with this empty-state message in the body.
  return (
    <p className="text-sm text-un1t-light">
      You don&apos;t have access to any dashboards yet. Ask an admin to enable
      Today, Studio, or Business in your profile.
    </p>
  )
}
