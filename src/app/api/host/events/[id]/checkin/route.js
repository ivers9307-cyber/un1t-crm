// POST / DELETE /api/host/events/[id]/checkin — HOSTCHECKIN.1
//
// A host checks people in at the door of one of their OWN events (404
// otherwise), the twin of the staff route /api/events/[id]/checkin:
//   POST   { team_member_id, race_registration_id }  → mark present (idempotent)
//   DELETE ?team_member_id=…&race_registration_id=…  → undo
// Same resolution (a placed solo entry follows to its team), same rows in
// race_checkins (checked_in_by stays empty: a host is not a staff profile),
// same race.checked_in contact event. A cancelled or unpaid entry is refused.
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { withHostAuth } from '@/lib/with-host-auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { emitEvent, EVENT_TYPES } from '@/lib/contact-events'
import { checkinStatusRefusal } from '@/lib/placed-checkin'
import { resolveCheckinTarget } from '@/lib/event-checkin-write'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Schema = z.object({ team_member_id: uuidLike, race_registration_id: uuidLike })
const notFound = () => NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

// The person, on a registration of this event, of an event this host owns.
async function resolveForHost(db, host, eventId, registrationId, memberId) {
  if (!uuidLike.safeParse(eventId).success) return { response: notFound() }
  const r = await resolveCheckinTarget(db, eventId, registrationId, memberId)
  if (r.error) {
    if (r.status === 404) return { response: notFound() }
    return { response: NextResponse.json({ success: false, error: r.error }, { status: r.status }) }
  }
  if (r.hostId !== host.id) return { response: notFound() }
  return { r }
}

export const POST = withHostAuth(async ({ host, db, request, params }) => {
  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const { team_member_id, race_registration_id } = validation.data

  const { r, response } = await resolveForHost(db, host, params?.id, race_registration_id, team_member_id)
  if (response) return response

  const refusal = checkinStatusRefusal(r.registrationStatus)
  if (refusal) return NextResponse.json({ success: false, error: refusal, code: 'not_checkable', status: r.registrationStatus }, { status: 409 })

  const { error } = await db.from('race_checkins').insert({
    race_registration_id: r.registrationId,
    team_member_id: r.member.id,
    contact_id: r.member.contact_id || null,
    location_id: r.locationId,
    checked_in_by: null,
  })
  // UNIQUE(registration, member) → a re-tap is a clean no-op, not an error.
  if (error && !/duplicate|unique|23505/i.test(error.message || '')) {
    logError('host-checkin', 'check-in insert failed', { err: error, eventId: params.id, registrationId: r.registrationId })
    return NextResponse.json({ success: false, error: 'Could not check them in. Try again.' }, { status: 500 })
  }

  if (r.member.email) {
    await emitEvent({
      db,
      eventType: EVENT_TYPES.RACE_CHECKED_IN,
      contactEmail: r.member.email,
      contactId: r.member.contact_id || null,
      locationId: r.locationId,
      sourceType: 'race_registration',
      sourceId: r.registrationId,
      metadata: { event_id: params.id, team_member_id: r.member.id, via: 'host' },
    })
  }
  return NextResponse.json({ success: true, data: { checked_in: true } })
})

export const DELETE = withHostAuth(async ({ host, db, request, params }) => {
  const url = new URL(request.url)
  const memberId = url.searchParams.get('team_member_id') || ''
  const registrationId = url.searchParams.get('race_registration_id') || ''
  if (!uuidLike.safeParse(memberId).success || !uuidLike.safeParse(registrationId).success) {
    return NextResponse.json({ success: false, error: 'team_member_id and race_registration_id are required' }, { status: 400 })
  }
  const { r, response } = await resolveForHost(db, host, params?.id, registrationId, memberId)
  if (response) return response

  const { error } = await db
    .from('race_checkins')
    .delete()
    .eq('race_registration_id', r.registrationId)
    .eq('team_member_id', r.member.id)
  if (error) {
    logError('host-checkin', 'undo failed', { err: error, eventId: params.id, registrationId: r.registrationId })
    return NextResponse.json({ success: false, error: 'Could not undo that. Try again.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, data: { checked_in: false } })
})
