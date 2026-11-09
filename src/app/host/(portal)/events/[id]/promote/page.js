// Promote tab of a host's event page (HOSTPORTAL.2): the public event link to
// share, promo codes and the series actions. The layout above renders the
// header and tab strip; this page repeats the gate (getCurrentHost +
// loadHostEvent, 404 for a missing or another host's event) because a layout
// is never the only gate. Plain data only crosses into the client components.

import { notFound, redirect } from 'next/navigation'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { loadHostEvent, loadHostToday } from '@/lib/host-portal'
import { hostEventPublicUrl } from '@/lib/host-event-url'
import { announceBlockedReason } from '@/lib/host-announce-draft'
import { logWarn } from '@/lib/log'
import { eventIsPublic } from '@/lib/host-events'
import CopyLinkButton from '@/components/host/CopyLinkButton'
import EventShareLinks from '@/components/host/EventShareLinks'
import AnnounceEventButton from '@/components/host/AnnounceEventButton'
import HostPromoCodes from '@/components/host/HostPromoCodes'
import HostSeriesActions from '@/components/host/HostSeriesActions'

export const dynamic = 'force-dynamic'

export default async function HostEventPromote(props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) redirect('/host/login')

  const db = createServerClient()
  const event = await loadHostEvent(
    db,
    session.host.id,
    params.id,
    'id, host_id, name, slug, status, active, race_date, series_id, series:event_series ( id, name, slug )'
  )
  if (!event) notFound()

  // The public event page lives on the tenant host of the host's ANCHOR
  // location, as on Your page (hostEventPublicUrl, origin-only). A failure
  // hides only the Share block's link.
  let eventUrl = null
  try {
    eventUrl = await hostEventPublicUrl(db, session.host.id, event.slug)
  } catch (e) {
    logWarn('host-portal', 'promote link unavailable', { err: e, eventId: event.id })
  }

  // Why the email shortcut is unavailable (a plain string, or null when it is
  // available), judged on the host's own clock.
  const { today } = await loadHostToday(db, session.host)
  const blockedReason = announceBlockedReason(event, today)

  // The host's own list size for the Email your list block. A failed count
  // hides the count line only (null), never reads as 0.
  const { count: contactCount, error: countError } = await db
    .from('host_contacts')
    .select('id', { count: 'exact', head: true })
    .eq('host_id', session.host.id)
  if (countError) logWarn('host-portal', 'promote contact count failed', { err: countError, eventId: event.id })

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-lg font-semibold">Share</h2>
        {eventUrl ? (
          <>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 text-sm text-white/60 break-all">{eventUrl}</p>
            <div className="shrink-0 flex items-center gap-2">
              <a
                href={eventUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-lg border border-white/15 text-white/80 text-xs font-semibold px-3 py-1.5 hover:bg-white/10 hover:text-white"
              >
                Open
              </a>
              <CopyLinkButton url={eventUrl} />
            </div>
          </div>
          <EventShareLinks url={eventUrl} eventId={event.id} onSale={eventIsPublic(event)} />
          </>
        ) : (
          <p className="mt-3 text-white/40 text-sm">The link is unavailable right now.</p>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold">Email your list</h2>
        <div className="mt-3">
          <AnnounceEventButton
            eventId={event.id}
            blockedReason={blockedReason}
            contactCount={!countError && typeof contactCount === 'number' ? contactCount : null}
          />
        </div>
      </section>

      <HostPromoCodes eventId={event.id} />

      <section>
        <h2 className="text-lg font-semibold">Series</h2>
        <div className="mt-3">
          <HostSeriesActions
            eventId={event.id}
            eventName={event.name}
            raceDate={event.race_date}
            seriesId={event.series_id || null}
            seriesName={event.series?.name || ''}
            seriesSlug={event.series?.slug || ''}
          />
        </div>
      </section>
    </div>
  )
}
