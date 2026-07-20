// /dashboard — entry. Redirects to the user's preferred dashboard
// (or the most-aggregated they have access to). If none, renders
// the "no dashboards available" stub inside the dashboard layout's
// chrome.
//
// PERF.1 — resolution logic extracted into `resolveDashboardTarget`
// so the root `/` route can do the same work and redirect ONCE
// instead of cascading via this page. See src/lib/dashboard-redirect.js.
//
// REPSET-ACCOUNT.1 — the ACCOUNT-tier redirect (multi-studio owner →
// /portfolio) deliberately lives ONLY on `/` (the login landing), NOT
// here. `/dashboard` is the studio drill-in target: "Open studio →" on
// the portfolio sets the active location and navigates here, so a
// ≥2-studios redirect on this route would bounce the owner straight
// back to /portfolio (a loop). This page stays the per-studio surface.

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
    <p className="text-sm text-un1t-subtle">
      You don&apos;t have access to any dashboards yet. Ask an admin to enable
      Today, Studio, or Business in your profile.
    </p>
  )
}
