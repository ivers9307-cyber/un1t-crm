// /dashboard — entry. Redirects to the most-aggregated sub-view the
// user has permission for. If none, a "no dashboards available" stub.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import AppShellServer from '@/components/AppShellServer'

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

  return (
    <AppShellServer>
      <div className="p-6 max-w-2xl">
        <h1 className="text-2xl font-bold text-un1t-white mb-2">Dashboard</h1>
        <p className="text-sm text-un1t-light">
          You don&apos;t have access to any dashboards yet. Ask an admin to enable
          Today, Studio, or Business in your profile.
        </p>
      </div>
    </AppShellServer>
  )
}
