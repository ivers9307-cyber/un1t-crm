// POST /api/events/[id]/donations/[donationId]/refunded
//
// Record-only "Mark as refunded": the money was returned outside the CRM (in
// the provider's dashboard). Flips a paid donation to refunded and stamps who
// did it. Manager+ at the event's location.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { hasRoleAtLocation } from '@/lib/role-at-location'
import { MANAGER_ROLES } from '@/lib/schemas'
import { createServerClient } from '@/lib/supabase'
import { markDonationRefunded } from '@/lib/donation-payments'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NOT_PAID = { success: false, error: 'Only a paid donation can be marked as refunded', code: 'not_paid' }

export async function POST(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermissionAtAnyLocation(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Races feature is disabled at this location' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: race, error: raceErr } = await db
    .from('race_events')
    .select('id, location_id')
    .eq('id', params.id)
    .single()
  if (raceErr || !race) return NextResponse.json({ success: false, error: 'Race not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, race.location_id)
  if (guard) return guard
  // ROLESWEEP.1b — judged at the event's location, not the caller's active studio.
  if (!hasPermissionForLocation(user, race.location_id, 'races')) {
    return NextResponse.json({ success: false, error: 'Races feature is disabled at this location' }, { status: 403 })
  }
  if (!hasRoleAtLocation(user, race.location_id, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Manager access required' }, { status: 403 })
  }

  const { data: donation, error: readErr } = await db
    .from('donations')
    .select('id, status')
    .eq('id', params.donationId)
    .eq('race_event_id', race.id)
    .maybeSingle()
  if (readErr) return NextResponse.json({ success: false, error: readErr.message }, { status: 500 })
  if (!donation) return NextResponse.json({ success: false, error: 'Donation not found' }, { status: 404 })
  if (donation.status !== 'paid') return NextResponse.json(NOT_PAID, { status: 409 })

  try {
    const { changed } = await markDonationRefunded({ db, donationId: donation.id, byProfileId: user.id })
    // Lost a race with another refund click: the row is no longer paid.
    if (!changed) return NextResponse.json(NOT_PAID, { status: 409 })
    return NextResponse.json({ success: true, data: { changed } })
  } catch (err) {
    logError('event-donations', 'mark as refunded failed', { donationId: donation.id, error: err?.message })
    return NextResponse.json({ success: false, error: 'Could not mark the donation as refunded' }, { status: 500 })
  }
}
