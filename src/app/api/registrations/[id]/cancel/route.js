import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { getUserLocationIds, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { logError } from '@/lib/log'
import { MANAGER_ROLES } from '@/lib/schemas'
import { cancelRaceRegistration, placedSolosRefusal } from '@/lib/race-cancel'

// AGENT-EVENTS.3 — operator cancellation for a race/event
// registration (the first cancel primitive these rows have had).
// Capacity frees implicitly: wave counts exclude cancelled rows.
// Refunds, if any, are decided and processed by a human in Revolut.
// withAuth only signs the caller in: manager+ somewhere, then at the event's
// studio (404 outside the caller's studios), stay here in their old order.
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, params }) => {
  if (!hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const { data: reg } = await db.from('race_registrations')
    .select('id, race_events!inner(location_id)')
    .eq('id', params?.id)
    .maybeSingle()
  // 404 (not 403) so registration ids can't be enumerated.
  if (!reg) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const allowed = getUserLocationIds(user) // null = master
  if (allowed !== null && !allowed.includes(reg.race_events.location_id)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  // ROLESWEEP.1b — judged at the registration's event location, not the
  // caller's active studio.
  if (!hasRoleAtLocation(user, reg.race_events.location_id, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const result = await cancelRaceRegistration(db, params?.id)
  // FINDTEAM.8 (I3) — a placed solo's row is not an active entry to cancel.
  if (!result.ok && result.error === 'not_active') {
    return NextResponse.json({
      success: false,
      error: 'not_active',
      message: 'This entrant has been placed in a team, so their own entry is no longer active and cannot be cancelled.',
    }, { status: 409 })
  }
  // FINDTEAM.9 — a team entry that solos were placed into: the same 409 the
  // registration DELETE answers, so cancelling never strands a placement.
  if (!result.ok && result.error === 'has_placed_solos') {
    return NextResponse.json(placedSolosRefusal(result.placedCount, 'cancelled'), { status: 409 })
  }
  if (!result.ok) {
    // A read failure carries the database's text; answer a fixed message.
    logError('race-cancel', 'registration cancel failed', { registrationId: reg.id, err: result.error })
    return NextResponse.json({ success: false, error: 'Could not cancel the registration. Try again.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, already_cancelled: !!result.alreadyCancelled })
})
