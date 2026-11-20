// GET /api/communications/events
//
// Lists the active location's events (race_events — races, workshops,
// seminars, open days, masterclasses) for the AudienceBuilder's
// "Registered for event" dropdown, each with a LIVE registration count
// (status IN pending_payment/confirmed). Manager+ only; master with no
// active location sees an empty list (must pick a location first).
// Active-location scoping mirrors /api/segments.
//
// Returns: { success, data: [{ id, name, kind, race_date, registration_count }] }

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { MANAGER_ROLES } from '@/lib/schemas'
import { logError } from '@/lib/log'
import { LIVE_REGISTRATION_STATUSES } from '@/lib/audience-filter'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The role at the ACTIVE studio (withAuth's roles, the same includes(user.role)
// check as before) with the same 403 text; no active studio answers the empty
// list below rather than withAuth's 400, as before.
export const GET = withAuth({ permission: null, location: false, roles: MANAGER_ROLES, forbiddenMessage: 'Manager+ required' }, async ({ user, db }) => {
  const activeLocationId = user.activeLocation?.id || null
  // A master with no active location can't scope the list — mirror
  // /api/segments and return empty rather than aggregate every tenant's
  // events into one dropdown.
  if (!activeLocationId) {
    return NextResponse.json({ success: true, data: [] })
  }

  const { data: events, error } = await db
    .from('race_events')
    .select('id, name, kind, race_date')
    .order('race_date', { ascending: false })
    .limit(200)
    .eq('location_id', activeLocationId)
  if (error) {
    logError('communications', 'events list failed', { err: error })
    return NextResponse.json({ success: false, error: 'Could not load the events.' }, { status: 400 })
  }

  const data = await Promise.all((events || []).map(async (ev) => {
    const { count } = await db
      .from('race_registrations')
      .select('id', { count: 'exact', head: true })
      .eq('race_event_id', ev.id)
      .in('status', LIVE_REGISTRATION_STATUSES)
    return { ...ev, registration_count: count || 0 }
  }))

  return NextResponse.json({ success: true, data })
})
