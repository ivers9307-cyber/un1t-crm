// /events/[id]/raffle — RAFFLE.1: the till, the sales list and the draw for a
// charity event's raffle. Same gate as the donations page: races at the
// event's studio; another studio's event is a 404.

import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import RafflePanel from '@/components/raffle/RafflePanel'
import { ArrowLeft } from 'lucide-react'

export const dynamic = 'force-dynamic'

export default async function EventRafflePage(props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermissionAtAnyLocation(user, 'races')) redirect('/')

  const db = createServerClient()
  const { data: race } = await db
    .from('race_events')
    .select('id, name, location_id')
    .eq('id', params.id)
    .single()
  if (!race) notFound()

  if (assertLocationAccess(user, race.location_id)) notFound()
  if (!hasPermissionForLocation(user, race.location_id, 'races')) redirect('/')

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <Link href="/events" className="inline-flex items-center gap-1.5 text-sm text-un1t-subtle hover:text-un1t-text mb-3">
        <ArrowLeft size={14} /> Back to Races
      </Link>
      <header className="mb-4">
        <div className="text-[11px] uppercase tracking-wider text-un1t-subtle">Raffle</div>
        <h1 className="text-2xl font-semibold text-un1t-text">{race.name}</h1>
      </header>
      <RafflePanel raceId={race.id} />
    </div>
  )
}
