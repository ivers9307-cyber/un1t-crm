// /dashboard/lead-radar — LEAD-RADAR.1 non-member triage radar,
// relocated from the standalone /lead-radar page in SIDEBAR-IA.1 so
// it sits under the Dashboard tab strip with Today/Studio/Business
// (the old URL is a next.config forever-alias — digest emails and
// bookmarks keep working).
//
// Server gate only; the dashboard itself is the LeadRadar client
// component (it fetches the API for fresh scores). Access is the
// lead_radar permission — owner + head_coach by default. The
// dashboard layout provides the page header + segmented control, so
// this page renders just the radar's explainer line + body.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { membershipStateForPage, membershipSettingsHref, canManageMembershipSource } from '@/lib/membership/state-for-page'
import MembershipSourceGate from '@/components/MembershipSourceGate'
import LeadRadar from '@/components/LeadRadar'

export const dynamic = 'force-dynamic'

export default async function DashboardLeadRadarPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login?redirect=/dashboard/lead-radar')
  if (!hasPermission(user, 'lead_radar')) redirect('/dashboard')

  // W1.M3a — the radar keys on glofox_membership_status (trial / lead /
  // ClassPass) and the synced bookings, so without a membership source it
  // is empty by construction. Say so instead of drawing an empty radar.
  const locationId = user.activeLocation?.id || null
  const membership = await membershipStateForPage(createServerClient(), locationId)

  return (
    <>
      <p className="text-sm text-un1t-subtle mb-6">
        The non-member base — leads, trials and ClassPass drop-ins. The
        Funnel is who to chase to convert; ClassPass is a read-only view
        of drop-ins (who rarely convert to a membership); Cleanup clears
        the dormant records out of your pipeline and campaign audiences.
      </p>
      <MembershipSourceGate
        state={membership}
        capability="memberships"
        settingsHref={membershipSettingsHref(locationId)}
        canManage={canManageMembershipSource(user, locationId)}
      >
        <LeadRadar />
      </MembershipSourceGate>
    </>
  )
}
