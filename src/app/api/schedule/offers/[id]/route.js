// src/app/api/schedule/offers/[id]/route.js
//
// REPLACE.1b — DELETE: a manager at the offer's studio withdraws an OPEN
// offer. Guarded on still open (a claim may have just won). Nobody is told:
// the coaches' cards disappear. 404 outside the studio (and for a malformed
// id), 403 for a member who is not a manager there.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation } from '@/lib/auth'
import { MANAGER_ROLES, uuidLike } from '@/lib/schemas'
import { readOffer, withdrawOffer } from '@/lib/shift-offer-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function DELETE(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!uuidLike.safeParse(params?.id).success) {
    return NextResponse.json({ success: false, error: 'Offer not found' }, { status: 404 })
  }
  const db = createServerClient()
  const { offer, error } = await readOffer(db, params.id)
  if (error) return NextResponse.json({ success: false, error: 'Could not read the offer' }, { status: 500 })
  if (!offer) return NextResponse.json({ success: false, error: 'Offer not found' }, { status: 404 })
  const notHere = assertLocationAccessOr404(user, offer.location_id)
  if (notHere) return notHere
  if (!hasRoleAtLocation(user, offer.location_id, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Only a manager at this studio can withdraw this offer' }, { status: 403 })
  }
  if (offer.status !== 'open') return NextResponse.json({ success: false, error: 'This offer is already closed.' }, { status: 409 })
  const res = await withdrawOffer(db, { offerId: offer.id, nowIso: new Date().toISOString() })
  if (res.error) return NextResponse.json({ success: false, error: 'Could not withdraw the offer' }, { status: 500 })
  if (!res.closed) return NextResponse.json({ success: false, error: 'This offer has just changed. Refresh and try again.' }, { status: 409 })
  return NextResponse.json({ success: true })
}
