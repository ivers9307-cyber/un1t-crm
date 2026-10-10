// /dashboard/churn-radar — CHURN-RADAR.1 at-risk member radar,
// relocated from the standalone /churn-radar page in SIDEBAR-IA.1 so
// it sits under the Dashboard tab strip with Today/Studio/Business
// (the old URL is a next.config forever-alias — digest emails and
// bookmarks keep working).
//
// Server gate only; the dashboard itself is the ChurnRadar client
// component (it polls the API for fresh scores). Access is the
// churn_radar permission — owner + head_coach by default. The
// dashboard layout provides the page header + segmented control, so
// this page renders just the radar's explainer line + body.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { membershipStateForPage, membershipSettingsHref, canManageMembershipSource } from '@/lib/membership/state-for-page'
import MembershipSourceGate from '@/components/MembershipSourceGate'
import ChurnRadar from '@/components/ChurnRadar'

export const dynamic = 'force-dynamic'

export default async function DashboardChurnRadarPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login?redirect=/dashboard/churn-radar')
  if (!hasPermission(user, 'churn_radar')) redirect('/dashboard')

  // W1.M3a — the radar scores MEMBERS, so without a membership source it
  // is empty by construction. Say so instead of drawing an empty radar.
  const locationId = user.activeLocation?.id || null
  const membership = await membershipStateForPage(createServerClient(), locationId)

  return (
    <>
      <p className="text-sm text-un1t-subtle mb-6">
        Paying members at risk of churning, scored on attendance. Act early —
        a quick check-in turns most of these around.
      </p>
      <MembershipSourceGate
        state={membership}
        capability="memberships"
        settingsHref={membershipSettingsHref(locationId)}
        canManage={canManageMembershipSource(user, locationId)}
      >
        <ChurnRadar />
      </MembershipSourceGate>
    </>
  )
}
