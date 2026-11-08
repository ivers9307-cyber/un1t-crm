// HOST-PORTAL.3 — host self-serve "edit event" page. Server-rendered + scoped:
// getCurrentHost() then event.host_id === host.id (notFound() otherwise, so ids
// can't be enumerated). Maps the DB row → an `initial` shape the client form
// hydrates from, deriving the single-session fields off the first race wave and
// the euros ticket price off non_member_fee_cents. A rejected event shows the
// reviewer's requested-changes note above the form.

import { notFound, redirect } from 'next/navigation'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { resolveHostOrgBrand } from '@/lib/host-org-brand'
import HostEventForm from '@/components/host/HostEventForm'
import { sessionsFromWaves } from '@/lib/event-sessions'

export const dynamic = 'force-dynamic'

export default async function HostEditEventPage(props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) redirect('/host/login')

  const db = createServerClient()
  const { data: event } = await db
    .from('race_events')
    .select(
      'id, host_id, status, rejected_reason, kind, name, description, race_date, ' +
        'registration_opens_at, registration_closes_at, allowed_team_sizes, non_member_fee_cents, pricing_tiers, ' +
        'hero_image_url, accent_hex, venue_name, venue_address, ' +
        'confirmation_email_subject, confirmation_email_intro, reminder_email_subject, reminder_email_intro, series_id, ' +
        'race_waves ( id, start_time, capacity, label, display_order )'
    )
    .eq('id', params.id)
    .maybeSingle()

  if (!event || event.host_id !== session.host.id) notFound()
  const brand = await resolveHostOrgBrand(db, session.host)

  const initial = {
    kind: event.kind,
    name: event.name,
    description: event.description,
    race_date: event.race_date,
    registration_opens_at: event.registration_opens_at,
    registration_closes_at: event.registration_closes_at,
    allowed_team_sizes: event.allowed_team_sizes,
    non_member_fee_cents: event.non_member_fee_cents,
    pricing_tiers: event.pricing_tiers ?? null,
    hero_image_url: event.hero_image_url,
    accent_hex: event.accent_hex,
    venue_name: event.venue_name,
    venue_address: event.venue_address,
    confirmation_email_subject: event.confirmation_email_subject,
    confirmation_email_intro: event.confirmation_email_intro,
    reminder_email_subject: event.reminder_email_subject,
    reminder_email_intro: event.reminder_email_intro,
    // HOSTSERIES.1 — every wave is a session row on the form (HH:MM).
    sessions: sessionsFromWaves(event.race_waves),
    series_id: event.series_id ?? null,
  }

  return (
    <div>
      <a href={`/host/events/${event.id}`} className="text-xs text-white/45 hover:text-white">← Back</a>
      <h1 className="mt-3 text-2xl font-bold">Edit event</h1>

      {event.status === 'rejected' && event.rejected_reason && (
        <div className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          <span className="font-semibold">{brand.name} asked for changes:</span> {event.rejected_reason}
        </div>
      )}

      <div className="mt-8">
        <HostEventForm mode="edit" eventId={event.id} initial={initial} brandName={brand.name} />
      </div>
    </div>
  )
}
