// /events/[id]/checkin — per-person attendance check-in (EVENT-CHECKIN.A).
//
// Server-loads the confirmed roster (registrations -> teams -> team_members)
// and stamps each member's checked_in from race_checkins, then hands off to
// the client component for tap-to-check-in. Works for every event kind;
// phone-browser friendly (the door device).

import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import EventCheckinClient from '@/components/EventCheckinClient'
import { loadCheckinRoster } from '@/lib/event-checkin-write'
import { ArrowLeft } from 'lucide-react'

export const dynamic = 'force-dynamic'

export default async function EventCheckinPage(props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  // PAGEGATES.1 — coarse pre-check only; the decision is at the event's
  // location below, the same one /api/events/[id]/checkin makes.
  if (!hasPermissionAtAnyLocation(user, 'races')) redirect('/')

  const db = createServerClient()
  const { data: race } = await db
    .from('race_events')
    .select(`
      id, name, slug, location_id, race_date, kind,
      waves:race_waves ( id, start_time, label, display_order ),
      registrations:race_registrations (
        id, status, wave_id,
        teams ( id, name, team_members ( id, name, email, contact_id ) )
      )
    `)
    .eq('id', params.id)
    .single()
  if (!race) notFound()

  if (assertLocationAccess(user, race.location_id)) notFound()
  if (!hasPermissionForLocation(user, race.location_id, 'races')) redirect('/')

  // Confirmed registrations only, each member stamped from race_checkins
  // (shared with the host check-in page, HOSTCHECKIN.1).
  const roster = await loadCheckinRoster(db, race)
  if (roster.error) throw roster.error
  const registrations = roster.rows

  const isRace = (race.kind || 'race') === 'race'

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <Link href="/events" className="inline-flex items-center gap-1.5 text-sm text-un1t-subtle hover:text-un1t-text mb-3">
        <ArrowLeft size={14} /> Back to Events
      </Link>
      <header className="mb-5">
        <div className="text-[11px] uppercase tracking-wider text-un1t-subtle">Check-in</div>
        <h1 className="text-2xl font-semibold text-un1t-text">{race.name}</h1>
        {race.race_date && (
          <p className="text-xs text-un1t-subtle mt-1">
            {new Date(`${race.race_date}T12:00:00Z`).toLocaleDateString('en-IE', {
              weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
            })}
          </p>
        )}
      </header>
      <EventCheckinClient eventId={race.id} isRace={isRace} registrations={registrations} />
    </div>
  )
}
