// POST /api/events/[id]/checkin/all — check in everyone on a registration
// in one tap ("check in whole team"). Idempotent: members already present
// are left as-is. Emits race.checked_in per newly-resolvable member.

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { emitEvent, EVENT_TYPES } from '@/lib/contact-events'

export const runtime = 'nodejs'

const Schema = z.object({
  race_registration_id: uuidLike,
})

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Events feature is disabled at this location' }, { status: 403 })
  }

  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const { race_registration_id } = validation.data

  const db = createServerClient()
  const { data: reg } = await db
    .from('race_registrations')
    .select('id, race_event_id, race_events!inner ( id, location_id ), teams ( id, team_members ( id, email, contact_id ) )')
    .eq('id', race_registration_id)
    .maybeSingle()
  if (!reg || reg.race_event_id !== params.id) {
    return NextResponse.json({ success: false, error: 'Registration not found for this event', status: 404 }, { status: 404 })
  }
  const locationId = reg.race_events?.location_id
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard

  const members = reg.teams?.team_members || []
  if (members.length === 0) {
    return NextResponse.json({ success: true, data: { checked_in: 0 } })
  }

  // Upsert one row per member; ignoreDuplicates leaves already-present
  // members untouched (and reports how many rows the insert affected).
  const rows = members.map((m) => ({
    race_registration_id,
    team_member_id: m.id,
    contact_id: m.contact_id || null,
    location_id: locationId,
    checked_in_by: user.id,
  }))
  const { error } = await db
    .from('race_checkins')
    .upsert(rows, { onConflict: 'race_registration_id,team_member_id', ignoreDuplicates: true })
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

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
      metadata: { event_id: params.id, team_member_id: m.id, via: 'check_in_all' },
    })
  }

  return NextResponse.json({ success: true, data: { checked_in: members.length } })
}
