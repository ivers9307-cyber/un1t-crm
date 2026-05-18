// /dashboard — entry. Redirects to the user's preferred dashboard
// (or the most-aggregated they have access to). If none, renders
// the "no dashboards available" stub inside the dashboard layout's
// chrome.
//
// PERF.1 — resolution logic extracted into `resolveDashboardTarget`
// so the root `/` route can do the same work and redirect ONCE
// instead of cascading via this page. See src/lib/dashboard-redirect.js.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { resolveDashboardTarget } from '@/lib/dashboard-redirect'

export const dynamic = 'force-dynamic'

export default async function DashboardIndex() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const target = resolveDashboardTarget(user)
  if (target) redirect(target)

  // Falls back to the layout's chrome (header + segmented control)
  // with this empty-state message in the body.
  return (
    <p className="text-sm text-un1t-light">
      You don&apos;t have access to any dashboards yet. Ask an admin to enable
      Today, Studio, or Business in your profile.
    </p>
  )
}
