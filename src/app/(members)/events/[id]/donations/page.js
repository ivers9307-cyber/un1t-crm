// /events/[id]/donations — staff view of an event's card donations: totals,
// the list, the CSV hand-over for the charity and "Mark as refunded".

import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import EventDonationsList from '@/components/EventDonationsList'
import { hasRoleAtLocation } from '@/lib/role-at-location'
import { MANAGER_ROLES } from '@/lib/schemas'
import { ArrowLeft } from 'lucide-react'

export const dynamic = 'force-dynamic'

export default async function EventDonationsPage(props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  // PAGEGATES.1 — coarse pre-check only; the decision is at the event's
  // location below, the same one every donations route makes.
  if (!hasPermissionAtAnyLocation(user, 'races')) redirect('/')

  const db = createServerClient()
  const { data: race } = await db
    .from('race_events')
    .select('id, name, location_id, race_date')
    .eq('id', params.id)
    .single()
  if (!race) notFound()

  if (assertLocationAccess(user, race.location_id)) notFound()
  if (!hasPermissionForLocation(user, race.location_id, 'races')) redirect('/')

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <Link href="/events" className="inline-flex items-center gap-1.5 text-sm text-un1t-subtle hover:text-un1t-text mb-3">
        <ArrowLeft size={14} /> Back to Races
      </Link>
      <header className="mb-5">
        <div className="text-[11px] uppercase tracking-wider text-un1t-subtle">Donations</div>
        <h1 className="text-2xl font-semibold text-un1t-text">{race.name}</h1>
        <p className="text-xs text-un1t-subtle mt-1">
          {new Date(race.race_date).toLocaleDateString('en-IE', {
            weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
          })}
        </p>
      </header>
      {/* Mark as refunded calls POST /api/events/[id]/donations/[donationId]/refunded,
          which requires MANAGER_ROLES at the event's studio. */}
      <EventDonationsList
        raceId={race.id}
        canMarkRefunded={hasRoleAtLocation(user, race.location_id, MANAGER_ROLES)}
      />
    </div>
  )
}
