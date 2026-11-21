// POST /api/host/events/[id]/checkin/all — HOSTCHECKIN.1
//
// A host checks in everyone on one registration of one of their OWN events
// (404 otherwise): the twin of /api/events/[id]/checkin/all. Already-present
// people are left as they are; a cancelled or unpaid entry is refused.
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { withHostAuth } from '@/lib/with-host-auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { emitEvent, EVENT_TYPES } from '@/lib/contact-events'
import { checkinStatusRefusal } from '@/lib/placed-checkin'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Schema = z.object({ race_registration_id: uuidLike })
const notFound = () => NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

export const POST = withHostAuth(async ({ host, db, request, params }) => {
  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const { race_registration_id } = validation.data
  if (!uuidLike.safeParse(params?.id).success) return notFound()

  const { data: reg, error: regErr } = await db
    .from('race_registrations')
    .select('id, race_event_id, status, race_events!inner ( id, location_id, host_id ), teams ( id, team_members ( id, email, contact_id ) )')
    .eq('id', race_registration_id)
    .maybeSingle()
  if (regErr) {
    logError('host-checkin', 'registration read failed', { err: regErr, registrationId: race_registration_id })
    return NextResponse.json({ success: false, error: 'Could not read the registration. Try again.' }, { status: 500 })
  }
  if (!reg || reg.race_event_id !== params.id || reg.race_events?.host_id !== host.id) return notFound()

  const refusal = checkinStatusRefusal(reg.status)
  if (refusal) return NextResponse.json({ success: false, error: refusal, code: 'not_checkable', status: reg.status }, { status: 409 })

  const locationId = reg.race_events.location_id
  const members = reg.teams?.team_members || []
  if (members.length === 0) return NextResponse.json({ success: true, data: { checked_in: 0 } })

  const rows = members.map((m) => ({
    race_registration_id,
    team_member_id: m.id,
    contact_id: m.contact_id || null,
    location_id: locationId,
    checked_in_by: null,
  }))
  const { error } = await db
    .from('race_checkins')
    .upsert(rows, { onConflict: 'race_registration_id,team_member_id', ignoreDuplicates: true })
  if (error) {
    logError('host-checkin', 'check-in-all upsert failed', { err: error, registrationId: race_registration_id })
    return NextResponse.json({ success: false, error: 'Could not check them in. Try again.' }, { status: 500 })
  }

  for (const m of members) {
    if (!m.email) continue
    await emitEvent({
      db,
      eventType: EVENT_TYPES.RACE_CHECKED_IN,
      contactEmail: m.email,
      contactId: m.contact_id || null,
      locationId,
      sourceType: 'race_registration',
      sourceId: race_registration_id,
      metadata: { event_id: params.id, team_member_id: m.id, via: 'host_check_in_all' },
    })
  }
  return NextResponse.json({ success: true, data: { checked_in: members.length } })
})
