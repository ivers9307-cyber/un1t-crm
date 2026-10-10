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
import { membershipStateForPage, membershipSettingsHref, canManageMembershipSource } from '@/lib/membership/state-for-page'
import MembershipSourceGate from '@/components/MembershipSourceGate'

export const dynamic = 'force-dynamic'

export default async function DashboardEngagementPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login?redirect=/dashboard/engagement')
  if (!hasPermission(user, 'engagement_analytics')) redirect('/dashboard')

  const locId = user.activeLocation?.id
  const db = createServerClient()
  // W1.M3a — the cross-tab is the churn radar's member base against its
  // at-risk verdict, so without a membership source there are no members
  // to tab. Gate it (the report query does not run) instead of "No
  // engagement data yet".
  const membership = await membershipStateForPage(db, locId)
  let report = null
  if (membership.state === 'configured') {
    // Best-effort — a query failure must not blank the dashboard chrome.
    try {
      report = await loadEngagementChurn(db, locId)
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
      <MembershipSourceGate
        state={membership}
        capability="memberships"
        settingsHref={membershipSettingsHref(locId)}
        canManage={canManageMembershipSource(user, locId)}
      >
        {report
          ? <EngagementReport report={report} />
          : <p className="text-sm text-un1t-muted">No engagement data yet for this location.</p>}
      </MembershipSourceGate>
    </>
  )
}
