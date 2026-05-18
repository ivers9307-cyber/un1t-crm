// Root — entry point. Previously redirected blindly to /dashboard
// which then ran auth + landing resolution and issued a SECOND
// redirect to the final destination. Vercel Speed Insights showed
// P75 FCP at 9.58s on this URL (177 events — by far the most-
// trafficked route) because of the multi-hop redirect cost, even
// though the destination page itself rendered in 1.86s.
//
// PERF.1 — collapse the chain. We now do the same auth + landing
// resolution work `/dashboard` does and redirect ONCE to the final
// destination. Both pages share the same `resolveDashboardTarget`
// helper so the resolution logic lives in exactly one place.
//
// Existing bookmarks / hard-coded `/` links keep working — the
// destination is unchanged; only the path through the cascade is
// shorter.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { resolveDashboardTarget } from '@/lib/dashboard-redirect'

export const dynamic = 'force-dynamic'

export default async function Root() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const target = resolveDashboardTarget(user)
  if (target) redirect(target)

  // User has no dashboard permission. Fall through to /dashboard
  // which renders the "no dashboards available" empty state inside
  // the dashboard layout chrome. Rare path (owners would normally
  // grant themselves at least one dashboard).
  redirect('/dashboard')
}
