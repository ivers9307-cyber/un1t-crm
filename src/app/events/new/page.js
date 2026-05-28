import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { MANAGER_ROLES } from '@/lib/schemas'
import RaceEventForm from '@/components/RaceEventForm'

export const dynamic = 'force-dynamic'

export default async function NewRacePage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!MANAGER_ROLES.includes(user.role)) redirect('/')
  if (!hasPermission(user, 'races')) redirect('/')

  return (
    <div className="p-8 max-w-2xl">
      <h2 className="text-2xl font-bold mb-1">New race event</h2>
      <p className="text-sm text-un1t-subtle mb-6">
        Standalone race occurrence (Hyrox sim, etc). Teams register via a public signup page; the
        race-day operator UI lets you start and finish each team&apos;s timer.
      </p>
      <RaceEventForm locationId={user.activeLocation?.id} />
    </div>
  )
}
