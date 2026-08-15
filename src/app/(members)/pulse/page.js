// /pulse — PULSE-90.4. The Pulse operator hub: the management home for the
// Pulse customer app. v1 content is the first-90-days journey lane (every new
// member scored against the 9-classes-in-6-weeks pace, worst-first, with a
// "Log touch" action). The hub CROSS-LINKS to the engagement dashboard +
// challenges admin rather than duplicating them; future Pulse features
// (cohort leaderboards, seasonal challenge) mount here too.
//
// Gated on the pulse_admin permission (owner + manager + head_coach by
// default — a retention oversight surface). Server-gated + redirect; the
// lane data itself streams into the client component via /api/pulse/journey
// (which re-checks the permission + IDOR-guards the location).

import { redirect } from 'next/navigation'
import Link from 'next/link'
import { BarChart3, Trophy } from 'lucide-react'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import JourneyLane from '@/components/pulse/JourneyLane'

export const dynamic = 'force-dynamic'

export default async function PulsePage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login?redirect=/pulse')
  if (!hasPermission(user, 'pulse_admin')) redirect('/dashboard')

  const canEngagement = hasPermission(user, 'engagement_analytics')
  const canChallenges = hasPermission(user, 'challenges')

  return (
    <div className="p-8 max-w-5xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-2">
        <h2 className="text-2xl font-bold">Pulse</h2>
        <div className="flex items-center gap-2">
          {canEngagement && (
            <Link
              href="/dashboard/engagement"
              className="inline-flex items-center gap-1.5 text-xs border border-un1t-border text-un1t-subtle hover:text-un1t-text px-3 py-1.5 rounded-md font-medium"
            >
              <BarChart3 size={12} /> Engagement analytics
            </Link>
          )}
          {canChallenges && (
            <Link
              href="/challenges"
              className="inline-flex items-center gap-1.5 text-xs border border-un1t-border text-un1t-subtle hover:text-un1t-text px-3 py-1.5 rounded-md font-medium"
            >
              <Trophy size={12} /> Challenges
            </Link>
          )}
        </div>
      </div>
      <p className="text-sm text-un1t-subtle mb-6">
        The first-90-days journey — every new member paced against their first classes in six weeks.
        Members drifting off pace surface first so a coach can reach out. Log a touch when you do.
      </p>

      <JourneyLane />
    </div>
  )
}
