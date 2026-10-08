// /events/[id]/teams — operator team-management view for a race.
//
// Lists every registration with team + members; lets the operator
// add a team manually (no payment), add/remove/edit members, edit
// member name/email, and move teams to different waves.

import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import RaceTeamsManager from '@/components/RaceTeamsManager'
import { hasRoleAtLocation } from '@/lib/role-at-location'
import { MANAGER_ROLES } from '@/lib/schemas'
import { ArrowLeft } from 'lucide-react'

export const dynamic = 'force-dynamic'

export default async function RaceTeamsPage(props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  // PAGEGATES.1 — coarse pre-check only; the decision is at the event's
  // location below, the same one every teams route makes.
  if (!hasPermissionAtAnyLocation(user, 'races')) redirect('/')

  const db = createServerClient()
  const { data: race } = await db
    .from('race_events')
    .select(`
      id, name, slug, location_id, race_date, allowed_team_sizes, payment_currency,
      waves:race_waves ( id, start_time, capacity, label, display_order )
    `)
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
        <div className="text-[11px] uppercase tracking-wider text-un1t-subtle">Teams</div>
        <h1 className="text-2xl font-semibold text-un1t-text">{race.name}</h1>
        <p className="text-xs text-un1t-subtle mt-1">
          {new Date(race.race_date).toLocaleDateString('en-IE', {
            weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
          })}
        </p>
      </header>
      {/* GATES-2 — Cancel entry calls POST /api/registrations/[id]/cancel,
          which requires MANAGER_ROLES at the event's studio. EVENT-MOVE.1 —
          Move to event calls POST /api/event-registrations/[id]/move, same
          rule at the source studio (and again at the target's). */}
      <RaceTeamsManager
        race={race}
        canCancelEntries={hasRoleAtLocation(user, race.location_id, MANAGER_ROLES)}
        canMoveEntries={hasRoleAtLocation(user, race.location_id, MANAGER_ROLES)}
        currency={race.payment_currency || 'EUR'}
      />
    </div>
  )
}
