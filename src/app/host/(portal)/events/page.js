// Host events (HOSTPORTAL.1): the host's events grouped by where each is in its
// life — needs action, upcoming, series, past. Server-rendered + scoped to
// host_id. Revenue and ratings are display only: a failed read drops the sold,
// money and rating figures from the rows and the page still renders.

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getCurrentHost } from '@/lib/host-auth'
import { getHostRevenue } from '@/lib/host-revenue'
import { createServerClient } from '@/lib/supabase'
import { HOST_EVENT_STATUS_LABEL } from '@/lib/host-events'
import { listHostSeries } from '@/lib/event-series'
import { logWarn } from '@/lib/log'
import {
  loadHostToday,
  groupHostEvents,
  eventLandingHref,
  hostEventDetail,
  loadPublicRatingAverages,
} from '@/lib/host-portal'
import HostEventRow from '@/components/host/HostEventRow'
import HostPastEvents from '@/components/host/HostPastEvents'
import HostSubmitButton from '@/components/host/HostSubmitButton'
import HostSeriesList from '@/components/host/HostSeriesList'

export const dynamic = 'force-dynamic'

const H2 = 'text-xs uppercase tracking-[0.15em] text-white/45 mb-3'

export default async function HostEventsPage() {
  const session = await getCurrentHost()
  if (!session) redirect('/host/login')
  const host = session.host

  const db = createServerClient()
  const { data: events, error } = await db
    .from('race_events')
    .select('id, name, slug, race_date, kind, active, status')
    .eq('host_id', host.id)
    .order('race_date', { ascending: false })
    .limit(200)
  if (error) logWarn('host-events', 'events read failed', { err: error })
  const list = events || []

  let revenue = null
  try {
    revenue = await getHostRevenue(db, host.id)
  } catch (e) {
    logWarn('host-events', 'revenue unavailable', { err: e })
  }
  const revenueByEvent = new Map((revenue?.perEvent || []).map((r) => [r.event_id, r]))
  const cur = revenue?.currency || 'EUR'

  if (error) {
    return (
      <div>
        <h1 className="text-2xl font-bold">Events</h1>
        <p className="mt-6 text-white/50 text-sm">Your events are unavailable right now.</p>
      </div>
    )
  }

  const { today } = await loadHostToday(db, host)
  let series = []
  try {
    series = await listHostSeries(db, { hostId: host.id, today })
  } catch (e) {
    logWarn('host-events', 'series section degraded', { err: e })
    series = []
  }

  const { needsAction, upcoming, past } = groupHostEvents(list, today)

  let ratings = null
  try {
    ratings = await loadPublicRatingAverages(db, past.map((e) => e.id))
  } catch (e) {
    logWarn('host-events', 'ratings unavailable', { err: e })
  }

  function detailFor(e, withRating) {
    return hostEventDetail(host, e, revenueByEvent.get(e.id), cur, { rating: withRating ? ratings?.get(e.id) : null })
  }

  function renderRows(title, rows) {
    if (rows.length === 0) return null
    return (
      <section className="mt-8" key={title}>
        <h2 className={H2}>{title}</h2>
        <ul className="divide-y divide-white/10 rounded-xl border border-white/10 overflow-hidden">
          {rows.map((e) => (
            <HostEventRow
              key={e.id}
              event={e}
              detail={detailFor(e, false)}
              action={e.status === 'draft' ? <HostSubmitButton eventId={e.id} /> : null}
            />
          ))}
        </ul>
      </section>
    )
  }

  const pastRows = past.map((e) => ({
    id: e.id,
    name: e.name,
    status: e.status,
    statusLabel: HOST_EVENT_STATUS_LABEL[e.status] || e.status,
    href: eventLandingHref(e),
    detail: detailFor(e, true),
  }))

  return (
    <div>
      <h1 className="text-2xl font-bold">Events</h1>
      <p className="text-white/60 mt-1 text-sm">
        {list.length} event{list.length === 1 ? '' : 's'}{series.length > 0 ? ` · ${series.length} series` : ''}
      </p>

      {list.length === 0 && (
        <p className="mt-8 text-white/50 text-sm">
          No events yet — <Link href="/host/events/new" className="text-white underline underline-offset-2 hover:text-white/80">create your first one</Link>.
        </p>
      )}

      {renderRows('Needs action', needsAction)}
      {renderRows('Upcoming', upcoming)}
      <HostSeriesList series={series} />
      {past.length > 0 && (
        <section className="mt-8">
          <h2 className={H2}>Past</h2>
          <HostPastEvents rows={pastRows} />
        </section>
      )}
    </div>
  )
}
