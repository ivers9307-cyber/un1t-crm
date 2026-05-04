import { redirect, notFound } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { MANAGER_ROLES } from '@/lib/schemas'
import RaceEventForm from '@/components/RaceEventForm'

export const dynamic = 'force-dynamic'

export default async function EditRacePage({ params }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!MANAGER_ROLES.includes(user.role)) redirect('/')

  const db = createServerClient()
  const { data: race } = await db
    .from('race_events')
    .select('*')
    .eq('id', params.id)
    .single()

  if (!race) notFound()
  const guard = assertLocationAccess(user, race.location_id)
  if (guard) redirect('/')

  return (
    <div className="p-8 max-w-2xl">
      <h2 className="text-2xl font-bold mb-1">Edit race</h2>
      <p className="text-sm text-un1t-light mb-6">{race.name}</p>
      <RaceEventForm race={race} locationId={race.location_id} />
    </div>
  )
}
