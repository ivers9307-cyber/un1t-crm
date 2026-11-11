// Insights tab of a host's event page (HOSTPORTAL.2): the signups funnel card
// and the ratings, two columns from lg and stacked below. The layout above
// renders the header and tab strip; this page repeats the gate
// (getCurrentHost + loadHostEvent) because a layout is never the only gate.

import { notFound, redirect } from 'next/navigation'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { loadHostEvent } from '@/lib/host-portal'
import { loadEventStats } from '@/lib/event-stats'
import { logWarn } from '@/lib/log'
import EventSignupsCard from '@/components/EventSignupsCard'
import HostEventRatings from '@/components/host/HostEventRatings'

export const dynamic = 'force-dynamic'

export default async function HostEventInsights(props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) redirect('/host/login')

  const db = createServerClient()
  const event = await loadHostEvent(db, session.host.id, params.id, 'id, host_id')
  if (!event) notFound()

  // A failed stats read renders the card's "unavailable" line, never zeros.
  let stats = null
  try {
    const statsRes = await loadEventStats(db, event.id)
    stats = statsRes.ok ? statsRes.stats : null
  } catch (e) {
    logWarn('host-portal', 'event stats failed', { err: e, eventId: event.id })
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <EventSignupsCard stats={stats} dark />
      <HostEventRatings eventId={event.id} />
    </div>
  )
}
