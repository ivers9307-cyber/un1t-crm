// POST /api/events/[id]/checkin/scan — check in by scanning a per-attendee
// QR. The QR opens a staff-only landing page that POSTs its token here. The
// token carries identity (registration + member); authorisation is the staff
// session + location access, same as the manual roster routes.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { emitEvent, EVENT_TYPES } from '@/lib/contact-events'
import { verifyCheckinToken } from '@/lib/event-checkin-tokens'

export const runtime = 'nodejs'

const Schema = z.object({ token: z.string().min(1).max(2000) })

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Events feature is disabled at this location' }, { status: 403 })
  }
  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response

  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret) return NextResponse.json({ success: false, error: 'Check-in temporarily unavailable' }, { status: 503 })
  const payload = verifyCheckinToken(validation.data.token, secret)
  if (!payload || payload.eventId !== params.id) {
    return NextResponse.json({ success: false, error: 'Invalid check-in code', code: 'bad_token' }, { status: 400 })
  }

  const db = createServerClient()
  const { data: reg } = await db
    .from('race_registrations')
    .select('id, race_event_id, race_events!inner ( id, location_id ), teams ( id, team_members ( id, name, email, contact_id ) )')
    .eq('id', payload.registrationId)
    .maybeSingle()
  if (!reg || reg.race_event_id !== params.id) {
    return NextResponse.json({ success: false, error: 'Registration not found for this event' }, { status: 404 })
  }
  const locationId = reg.race_events?.location_id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  const member = (reg.teams?.team_members || []).find((m) => m.id === payload.memberId)
  if (!member) return NextResponse.json({ success: false, error: 'That person is not on this registration' }, { status: 400 })

  const { error } = await db.from('race_checkins').insert({
    race_registration_id: payload.registrationId,
    team_member_id: payload.memberId,
    contact_id: member.contact_id || null,
    location_id: locationId,
    checked_in_by: user.id,
  })
  if (error && !/duplicate|unique|23505/i.test(error.message || '')) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  if (member.email) {
    await emitEvent({
      db,
      eventType: EVENT_TYPES.RACE_CHECKED_IN,
      contactEmail: member.email,
      contactId: member.contact_id || null,
      locationId,
      sourceType: 'race_registration',
      sourceId: payload.registrationId,
      metadata: { event_id: params.id, team_member_id: payload.memberId, via: 'qr' },
    })
  }

  return NextResponse.json({ success: true, data: { checked_in: true, name: member.name || member.email || 'Attendee' } })
}
