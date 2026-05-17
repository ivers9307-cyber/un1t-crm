// /events/[id]/teams — operator team-management view for a race.
//
// Lists every registration with team + members; lets the operator
// add a team manually (no payment), add/remove/edit members, edit
// member name/email, and move teams to different waves.

import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { MANAGER_ROLES } from '@/lib/schemas'
import RaceTeamsManager from '@/components/RaceTeamsManager'
import { ArrowLeft } from 'lucide-react'

export const dynamic = 'force-dynamic'

export default async function RaceTeamsPage(props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!MANAGER_ROLES.includes(user.role)) redirect('/')
  if (!hasPermission(user, 'races')) redirect('/')

  const db = createServerClient()
  const { data: race } = await db
    .from('race_events')
    .select(`
      id, name, slug, location_id, race_date, allowed_team_sizes,
      waves:race_waves ( id, start_time, capacity, label, display_order )
    `)
    .eq('id', params.id)
    .single()
  if (!race) notFound()

  const guard = assertLocationAccess(user, race.location_id)
  if (guard) redirect('/')

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <Link href="/events" className="inline-flex items-center gap-1.5 text-sm text-un1t-light hover:text-un1t-white mb-3">
        <ArrowLeft size={14} /> Back to Races
      </Link>
      <header className="mb-5">
        <div className="text-[11px] uppercase tracking-wider text-un1t-light">Teams</div>
        <h1 className="text-2xl font-semibold text-un1t-white">{race.name}</h1>
        <p className="text-xs text-un1t-light mt-1">
          {new Date(race.race_date).toLocaleDateString('en-IE', {
            weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
          })}
        </p>
      </header>
      <RaceTeamsManager race={race} />
    </div>
  )
}
