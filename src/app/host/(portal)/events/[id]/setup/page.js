// Set up tab of a host's event page (HOSTPORTAL.2): the edit form, reachable
// for every event status. The layout above renders the header, actions and tab
// strip; this page repeats the gate (getCurrentHost + loadHostEvent, 404 for a
// missing or another host's event) because a layout is never the only gate.
// hostEventFormInitial maps the row to the form's `initial`: every column the
// PUT route writes must reach the form or the next save wipes it
// (tests/host-event-edit-roundtrip-guard.test.js reads this file). A rejected
// event shows the reviewer's requested-changes note above the form.

import { notFound, redirect } from 'next/navigation'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { resolveHostOrgBrand } from '@/lib/host-org-brand'
import { loadHostEvent } from '@/lib/host-portal'
import HostEventForm from '@/components/host/HostEventForm'
import { hostEventFormInitial } from '@/lib/host-event-form-initial'
import { HOST_NOTICE, HOST_NOTICE_TONE } from '@/components/host/host-ui'

export const dynamic = 'force-dynamic'

export default async function HostEventSetup(props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) redirect('/host/login')

  const db = createServerClient()
  const event = await loadHostEvent(
    db,
    session.host.id,
    params.id,
    'id, host_id, status, rejected_reason, kind, name, description, race_date, ' +
      'registration_opens_at, registration_closes_at, allowed_team_sizes, non_member_fee_cents, pricing_tiers, registration_questions, duration_minutes, ' +
      'hero_image_url, accent_hex, venue_name, venue_address, ' +
      'confirmation_email_subject, confirmation_email_intro, reminder_email_subject, reminder_email_intro, rating_email_subject, rating_email_intro, series_id, ' +
      'race_waves ( id, start_time, capacity, label, display_order )'
  )
  if (!event) notFound()
  const brand = await resolveHostOrgBrand(db, session.host)

  const initial = hostEventFormInitial(event)

  return (
    <div>
      {event.status === 'rejected' && event.rejected_reason && (
        <div className={`mb-6 ${HOST_NOTICE} ${HOST_NOTICE_TONE.warn}`}>
          <span className="font-semibold">{brand.name} asked for changes:</span> {event.rejected_reason}
        </div>
      )}
      <HostEventForm mode="edit" eventId={event.id} initial={initial} brandName={brand.name} status={event.status} />
    </div>
  )
}
