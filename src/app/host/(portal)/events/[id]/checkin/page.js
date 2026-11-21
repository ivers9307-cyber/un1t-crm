// Check-in tab of a host's event page (HOSTCHECKIN.1): the door roster for
// one of the host's OWN events, the same page staff use at
// /events/[id]/checkin (EventCheckinClient), in the host portal's theme and
// talking to /api/host/events/[id]/checkin. The layout above renders the
// header and tabs; this page repeats the gate because a layout is never the
// only gate. Confirmed entries only.

import { notFound, redirect } from 'next/navigation'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { loadHostEvent } from '@/lib/host-portal'
import { loadCheckinRoster } from '@/lib/event-checkin-write'
import EventCheckinClient from '@/components/EventCheckinClient'

export const dynamic = 'force-dynamic'

const COLUMNS = `
  id, host_id, kind,
  waves:race_waves ( id, start_time, label, display_order ),
  registrations:race_registrations (
    id, status, wave_id,
    teams ( id, name, team_members ( id, name, email ) )
  )
`

export default async function HostEventCheckin(props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) redirect('/host/login')

  const db = createServerClient()
  const race = await loadHostEvent(db, session.host.id, params.id, COLUMNS)
  if (!race) notFound()

  const roster = await loadCheckinRoster(db, race)
  if (roster.error) throw roster.error

  return (
    <div className="mt-6">
      <EventCheckinClient
        eventId={race.id}
        isRace={(race.kind || 'race') === 'race'}
        registrations={roster.rows}
        apiBase={`/api/host/events/${race.id}/checkin`}
        host
      />
    </div>
  )
}
