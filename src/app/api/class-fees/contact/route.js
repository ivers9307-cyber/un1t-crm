// FEES.1 — GET the fees one member owes at one studio, for the profile card.
// ?location_id=&contact_id=  Session auth + the class_fees permission there.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { assertLocationAccess } from '@/lib/auth'
import { uuidLike } from '@/lib/schemas'
import { canUseClassFees } from '@/lib/class-fees-access'
import { contactOpenFees } from '@/lib/class-fees-run'
import { exemptContactIds } from '@/lib/class-fees-exemptions'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'

// The studio is the query's location_id, so withAuth only signs the caller in;
// the 400, the studio check and class_fees there (403) run here, as before.
export const GET = withAuth({ permission: null, location: false }, async ({ user, db, request }) => {
  const url = new URL(request.url)
  const locationId = url.searchParams.get('location_id')
  const contactId = url.searchParams.get('contact_id')
  if (!uuidLike.safeParse(locationId).success || !uuidLike.safeParse(contactId).success) {
    return NextResponse.json({ success: false, error: 'location_id and contact_id are required' }, { status: 400 })
  }
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!canUseClassFees(user, locationId)) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  try {
    const fees = await contactOpenFees(db, { locationId, contactId })
    const exempt = (await exemptContactIds(db, locationId, [contactId])).has(contactId)
    const owed = fees.filter((f) => f.status === 'retry_scheduled' || f.status === 'outstanding')
    return NextResponse.json({
      success: true,
      data: { fees, exempt, owed_cents: owed.reduce((s, f) => s + (f.amount_cents || 0), 0) },
    })
  } catch (err) {
    logError('class-fees', 'contact read failed', { locationId, code: err?.code ?? null })
    return NextResponse.json({ success: false, error: 'Could not load fees just now.' }, { status: 500 })
  }
})
