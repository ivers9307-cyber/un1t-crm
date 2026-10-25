import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import RaceEventForm from '@/components/RaceEventForm'
import { eventOwnerOptions } from '@/lib/event-owner'

export const dynamic = 'force-dynamic'

export default async function NewRacePage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'races')) redirect('/')

  // EVENT-OWNER.1 — the owner starts as the active studio and can be changed
  // to another studio of the org where this user runs events. An active
  // studio the picker cannot offer (a host anchor) keeps the old fixed owner.
  const offered = eventOwnerOptions(user, { organizationId: user.activeLocation?.organization_id || null })
  const ownerOptions = offered.some((o) => o.id === user.activeLocation?.id) ? offered : []

  return (
    <div className="p-8 max-w-2xl">
      <h2 className="text-2xl font-bold mb-1">New event</h2>
      <p className="text-sm text-un1t-subtle mb-6">
        Create an event — a race, workshop, seminar, open day, masterclass, or a lead-gen capture form.
        Customers sign up via a public page; the type you pick decides what the form collects.
      </p>
      <RaceEventForm
        locationId={user.activeLocation?.id}
        ownerName={user.activeLocation?.name || null}
        ownerOptions={ownerOptions}
      />
    </div>
  )
}
