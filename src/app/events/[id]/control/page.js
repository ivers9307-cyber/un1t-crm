// /events/[id]/control — Race-day operator interface (mig 082).
// Repurposed from /events/[id]/race; sources race_registrations
// instead of bookings.

import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { Tv } from 'lucide-react'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { MANAGER_ROLES } from '@/lib/schemas'
import RaceControlPanel from '@/components/RaceControlPanel'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function RaceControlPage({ params }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!MANAGER_ROLES.includes(user.role)) redirect('/')
  if (!hasPermission(user, 'races')) redirect('/')

  const db = createServerClient()
  const { data: race } = await db
    .from('race_events')
    .select('id, name, slug, location_id, race_date, start_time, active')
    .eq('id', params.id)
    .single()

  if (!race) notFound()
  const guard = assertLocationAccess(user, race.location_id)
  if (guard) redirect('/')

  return (
    <div className="p-4 sm:p-6 max-w-7xl">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold">{race.name} — Race control</h2>
          <p className="text-sm text-un1t-light mt-0.5">
            {race.race_date}{race.start_time ? ` · first wave ${race.start_time.slice(0, 5)}` : ''} · auto-refreshes every 2 seconds
          </p>
        </div>
        {race.slug && (
          <Link
            href={`/event/${race.slug}/display`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 border border-un1t-gray text-un1t-light text-sm font-medium px-4 py-2 rounded-lg hover:text-un1t-white hover:border-un1t-mid transition-colors"
            title="Public TV-friendly board for the studio screen"
          >
            <Tv size={16} />
            Open TV view
          </Link>
        )}
      </div>
      <RaceControlPanel raceId={race.id} />
    </div>
  )
}
