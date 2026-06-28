// /dashboard/engagement — P2-7 (Part B). Engagement → churn analytics:
// does community keep members? Cross-tabs the live member base by friend-count
// tier against the churn radar's at-risk signal + attendance, and tracks app /
// social adoption. Server-rendered (analytics, not live-polling). Gated on the
// engagement_analytics permission (owner + manager + head_coach by default).

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { loadEngagementChurn } from '@/lib/engagement-analytics-data'
import EngagementReport from '@/components/dashboard/EngagementReport'

export const dynamic = 'force-dynamic'

export default async function DashboardEngagementPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login?redirect=/dashboard/engagement')
  if (!hasPermission(user, 'engagement_analytics')) redirect('/dashboard')

  const locId = user.activeLocation?.id
  let report = null
  if (locId) {
    // Best-effort — a query failure must not blank the dashboard chrome.
    try {
      report = await loadEngagementChurn(createServerClient(), locId)
    } catch {
      report = null
    }
  }

  return (
    <>
      <p className="text-sm text-un1t-subtle mb-6">
        Does community keep members? This compares each friend-count tier against churn-risk and
        attendance — the data behind &ldquo;members with more friends churn less&rdquo; — and tracks
        app + social adoption.
      </p>
      {report
        ? <EngagementReport report={report} />
        : <p className="text-sm text-un1t-muted">No engagement data yet for this location.</p>}
    </>
  )
}
