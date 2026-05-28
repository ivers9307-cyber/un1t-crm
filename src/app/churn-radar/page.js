// /churn-radar — CHURN-RADAR.1 at-risk member radar.
//
// Server gate only; the dashboard itself is the ChurnRadar client
// component (it polls the API for fresh scores). Access is the
// churn_radar permission — owner + head_coach by default.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import ChurnRadar from '@/components/ChurnRadar'

export const dynamic = 'force-dynamic'

export default async function ChurnRadarPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login?redirect=/churn-radar')
  if (!hasPermission(user, 'churn_radar')) redirect('/dashboard')

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-un1t-text">Churn Radar</h1>
        <p className="text-sm text-un1t-subtle mt-1">
          Paying members at risk of churning, scored on attendance. Act early —
          a quick check-in turns most of these around.
        </p>
      </header>
      <ChurnRadar />
    </div>
  )
}
