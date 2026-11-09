// Shared header for every tab of a host's event page (HOSTPORTAL.2): the event's
// name, status, date/waves/venue/series line, the header actions and the tab
// strip. Every route under /host/events/<id>/… renders inside it. A layout is
// never the only gate: each page repeats getCurrentHost + loadHostEvent.

import { notFound, redirect } from 'next/navigation'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { loadHostEvent, HOST_STATUS_CHIP } from '@/lib/host-portal'
import { HOST_EVENT_STATUS_LABEL } from '@/lib/host-events'
import { resolveHostOrgBrand } from '@/lib/host-org-brand'
import GuardedLink from '@/components/host/GuardedLink'
import HostEventTabs from '@/components/host/HostEventTabs'
import HostEventMenu from '@/components/host/HostEventMenu'
import DuplicateEventButton from '@/components/DuplicateEventButton'

export const dynamic = 'force-dynamic'

const COLUMNS = 'id, host_id, status, name, slug, race_date, venue_name, series_id, series:event_series ( id, name, slug ), race_waves ( start_time, display_order )'

export default async function HostEventLayout({ children, params }) {
  const { id } = await params
  const session = await getCurrentHost()
  if (!session) redirect('/host/login')

  const db = createServerClient()
  const race = await loadHostEvent(db, session.host.id, id, COLUMNS)
  if (!race) notFound()

  const brand = await resolveHostOrgBrand(db, session.host)

  // Same population the old page's roster used (fetchEventAttendees applies no
  // status filter), so hasRegistrations keeps meaning "regs.length > 0". A
  // failed count is the safe side for Delete: assume there are registrations.
  const { count, error: countError } = await db
    .from('race_registrations')
    .select('id', { count: 'exact', head: true })
    .eq('race_event_id', id)
  const countOk = !countError && typeof count === 'number'
  const attendeeCount = countOk ? count : null
  const hasRegistrations = countOk ? count > 0 : true

  const waves = [...(race.race_waves || [])]
    .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))
    .map((w) => String(w.start_time || '').slice(0, 5))
    .filter(Boolean)
  const line = [race.race_date, waves.join(', '), race.venue_name].filter(Boolean)

  return (
    <div>
      <GuardedLink href="/host" className="text-xs text-white/45 hover:text-white">← Events</GuardedLink>

      <div className="mt-3 flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold break-words">{race.name}</h1>
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${HOST_STATUS_CHIP[race.status] || HOST_STATUS_CHIP.draft}`}>
              {HOST_EVENT_STATUS_LABEL[race.status] || race.status}
            </span>
          </div>
          {(line.length > 0 || race.series) && (
            <p className="text-white/55 text-sm mt-1">
              {line.join(' · ')}
              {race.series && (
                <>
                  {line.length > 0 ? ' · ' : ''}part of series{' '}
                  <a href={`/event/series/${race.series.slug}`} className="underline hover:text-white">{race.series.name}</a>
                </>
              )}
            </p>
          )}
        </div>
        <div className="shrink-0 flex items-center gap-2 flex-wrap">
          {race.slug && (
            <a
              href={`/event/${race.slug}`}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg border border-white/15 text-white/80 text-sm font-medium px-4 py-2 hover:bg-white/5"
            >
              View event page
            </a>
          )}
          <DuplicateEventButton
            eventId={race.id}
            raceDate={race.race_date}
            apiUrl={`/api/host/events/${race.id}/duplicate`}
            editHref="/host/events/{id}/setup"
            dark
          />
          <HostEventMenu eventId={race.id} status={race.status} hasRegistrations={hasRegistrations} brandName={brand.name} />
        </div>
      </div>

      <HostEventTabs eventId={race.id} attendeeCount={attendeeCount} />

      <div className="mt-6">{children}</div>
    </div>
  )
}
