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
import { hasPermission } from '@/lib/permissions'
import EventCheckinClient from '@/components/EventCheckinClient'
import { ArrowLeft } from 'lucide-react'

export const dynamic = 'force-dynamic'

export default async function EventCheckinPage(props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'races')) redirect('/')

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

  const guard = assertLocationAccess(user, race.location_id)
  if (guard) redirect('/')

  // Confirmed registrations only — cancelled / no_show aren't on the door list.
  const confirmed = (race.registrations || []).filter((r) => r.status === 'confirmed')

  // Stamp checked_in onto each member from race_checkins for this event.
  const regIds = confirmed.map((r) => r.id)
  let checkedSet = new Set()
  if (regIds.length) {
    const { data: checks } = await db
      .from('race_checkins')
      .select('race_registration_id, team_member_id')
      .in('race_registration_id', regIds)
    checkedSet = new Set((checks || []).map((c) => `${c.race_registration_id}:${c.team_member_id}`))
  }

  const wavesById = new Map((race.waves || []).map((w) => [w.id, w]))
  const waveLabel = (id) => {
    const w = wavesById.get(id)
    if (!w) return null
    return w.label || (w.start_time ? String(w.start_time).slice(0, 5) : null)
  }
  const waveOrder = (id) => wavesById.get(id)?.display_order ?? 999

  const registrations = confirmed
    .map((r) => ({
      id: r.id,
      wave_id: r.wave_id,
      wave_label: waveLabel(r.wave_id),
      _order: waveOrder(r.wave_id),
      team: {
        id: r.teams?.id || null,
        name: r.teams?.name || 'Entry',
        team_members: (r.teams?.team_members || []).map((m) => ({
          id: m.id,
          name: m.name || m.email || 'Member',
          email: m.email || null,
          checked_in: checkedSet.has(`${r.id}:${m.id}`),
        })),
      },
    }))
    .sort((a, b) => a._order - b._order || a.team.name.localeCompare(b.team.name))

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
