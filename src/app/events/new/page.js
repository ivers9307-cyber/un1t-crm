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
      <h2 className="text-2xl font-bold mb-1">New event</h2>
      <p className="text-sm text-un1t-subtle mb-6">
        Create an event — a race, workshop, seminar, open day, masterclass, or a lead-gen capture form.
        Customers sign up via a public page; the type you pick decides what the form collects.
      </p>
      <RaceEventForm locationId={user.activeLocation?.id} />
    </div>
  )
}
