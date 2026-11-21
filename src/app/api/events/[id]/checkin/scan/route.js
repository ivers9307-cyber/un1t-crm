// POST /api/events/[id]/checkin/scan — check in by scanning a per-attendee
// QR. The QR opens a staff-only landing page that POSTs its token here. The
// token carries identity (registration + member); authorisation is the staff
// session + location access, same as the manual roster routes.
//
// FINDTEAM.8 (I2): a placed solo's QR still names their own (placed) row; the
// check-in follows placed_into_registration_id and lands on the team they
// joined (their member row there, by contact, else email), never on the dead
// solo row.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { assertLocationAccessOr404 } from '@/lib/auth'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { emitEvent, EVENT_TYPES } from '@/lib/contact-events'
import { verifyCheckinToken } from '@/lib/event-checkin-tokens'
import { followPlacementForCheckin, isPlacedRedirect, checkinStatusRefusal, isAlreadyCheckedIn } from '@/lib/placed-checkin'

export const runtime = 'nodejs'

const Schema = z.object({ token: z.string().min(1).max(2000) })

// withAuth only signs the caller in (a staff session; the QR token is checked
// below, as before); races somewhere, the token, the event's studio (404) and
// races there stay by hand, in their old order.
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  if (!hasPermissionAtAnyLocation(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Events feature is disabled at this location' }, { status: 403 })
  }
  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response

  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret) return NextResponse.json({ success: false, error: 'Check-in temporarily unavailable' }, { status: 503 })
  const payload = verifyCheckinToken(validation.data.token, secret)
  if (!payload || payload.eventId !== params?.id) {
    return NextResponse.json({ success: false, error: 'Invalid check-in code', code: 'bad_token' }, { status: 400 })
  }

  const { data: reg, error: regErr } = await db
    .from('race_registrations')
    .select('id, race_event_id, status, contact_id, placed_into_registration_id, race_events!inner ( id, location_id ), teams ( id, team_members ( id, name, email, contact_id ) )')
    .eq('id', payload.registrationId)
    .maybeSingle()
  if (regErr) return NextResponse.json({ success: false, error: 'Could not read the registration' }, { status: 500 })
  if (!reg || reg.race_event_id !== params.id) {
    return NextResponse.json({ success: false, error: 'Registration not found for this event' }, { status: 404 })
  }
  const locationId = reg.race_events?.location_id
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard
  // ROLESWEEP.1b — judged at the event's location, not the caller's active studio.
  if (!hasPermissionForLocation(user, locationId, 'races')) {
    return NextResponse.json({ success: false, error: 'Events feature is disabled at this location' }, { status: 403 })
  }
  const scanned = (reg.teams?.team_members || []).find((m) => m.id === payload.memberId)
  if (!scanned) return NextResponse.json({ success: false, error: 'That person is not on this registration' }, { status: 400 })

  let member = scanned
  let registrationId = payload.registrationId
  let registrationStatus = reg.status
  if (isPlacedRedirect(reg)) {
    const followed = await followPlacementForCheckin(db, {
      eventId: params.id,
      placedIntoId: reg.placed_into_registration_id,
      person: { contact_id: scanned.contact_id || reg.contact_id || null, email: scanned.email },
    })
    if (!followed.ok) {
      if (followed.reason === 'load_failed') return NextResponse.json({ success: false, error: 'Could not read the registration' }, { status: 500 })
      if (followed.reason === 'not_found') return NextResponse.json({ success: false, error: 'Registration not found for this event' }, { status: 404 })
      return NextResponse.json({ success: false, error: 'That person is not on this registration' }, { status: 400 })
    }
    member = followed.member
    registrationId = followed.registrationId
    registrationStatus = followed.registrationStatus
  }
  // CHECKINSTATUS.1 — a cancelled or unpaid entry's QR no longer checks in.
  const refusal = checkinStatusRefusal(registrationStatus)
  if (refusal) return NextResponse.json({ success: false, error: refusal, code: 'not_checkable', status: registrationStatus }, { status: 409 })

  const { error } = await db.from('race_checkins').insert({
    race_registration_id: registrationId,
    team_member_id: member.id,
    contact_id: member.contact_id || null,
    location_id: locationId,
    checked_in_by: user.id,
  })
  const already = isAlreadyCheckedIn(error)
  if (error && !already) {
    logError('event-checkin-scan', 'check-in insert failed', { registrationId, code: error.code || null, err: error.message })
    return NextResponse.json({ success: false, error: 'Could not check them in. Try again.' }, { status: 400 })
  }
  // A repeat scan used to answer exactly like a first one, so door staff could
  // not tell a reused or shared code from a new arrival.
  if (already) {
    return NextResponse.json({ success: true, data: { checked_in: true, already_checked_in: true, name: member.name || member.email || 'Attendee' } })
  }

  if (member.email) {
    await emitEvent({
      db,
      eventType: EVENT_TYPES.RACE_CHECKED_IN,
      contactEmail: member.email,
      contactId: member.contact_id || null,
      locationId,
      sourceType: 'race_registration',
      sourceId: registrationId,
      metadata: { event_id: params.id, team_member_id: member.id, via: 'qr' },
    })
  }

  return NextResponse.json({ success: true, data: { checked_in: true, name: member.name || member.email || 'Attendee' } })
})
