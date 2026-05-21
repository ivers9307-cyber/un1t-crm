// /lead-radar — LEAD-RADAR.1 non-member triage radar.
//
// Server gate only; the dashboard itself is the LeadRadar client
// component (it fetches the API for fresh scores). Access is the
// lead_radar permission — owner + head_coach by default.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import LeadRadar from '@/components/LeadRadar'

export const dynamic = 'force-dynamic'

export default async function LeadRadarPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login?redirect=/lead-radar')
  if (!hasPermission(user, 'lead_radar')) redirect('/dashboard')

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-un1t-white">Lead Radar</h1>
        <p className="text-sm text-un1t-light mt-1">
          The non-member base — leads, trials and ClassPass drop-ins. The
          Funnel is who to chase to convert; Cleanup clears the dormant
          records out of your pipeline and campaign audiences.
        </p>
      </header>
      <LeadRadar />
    </div>
  )
}
