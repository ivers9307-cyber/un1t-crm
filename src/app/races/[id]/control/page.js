// /races/[id]/control — Race-day operator interface (mig 082).
// Repurposed from /events/[id]/race; sources race_registrations
// instead of bookings.

import { redirect, notFound } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { MANAGER_ROLES } from '@/lib/schemas'
import RaceControlPanel from '@/components/RaceControlPanel'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function RaceControlPage({ params }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!MANAGER_ROLES.includes(user.role)) redirect('/')

  const db = createServerClient()
  const { data: race } = await db
    .from('race_events')
    .select('id, name, location_id, race_date, start_time, active')
    .eq('id', params.id)
    .single()

  if (!race) notFound()
  const guard = assertLocationAccess(user, race.location_id)
  if (guard) redirect('/')

  return (
    <div className="p-4 sm:p-6 max-w-7xl">
      <div className="mb-4">
        <h2 className="text-2xl font-bold">{race.name} — Race control</h2>
        <p className="text-sm text-un1t-light mt-0.5">
          {race.race_date}{race.start_time ? ` · first wave ${race.start_time.slice(0, 5)}` : ''} · auto-refreshes every 2 seconds
        </p>
      </div>
      <RaceControlPanel raceId={race.id} />
    </div>
  )
}
