// FEES.3 — POST: charge an appealed fee after all. It goes back to pending,
// due now; the next hourly run charges it. Body { location_id }.
// Session auth + the class_fees permission at that studio; 404 for a fee at
// another studio.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { canUseClassFees } from '@/lib/class-fees-access'
import { chargeAppealedFee } from '@/lib/class-fees-member'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'

export const ChargeAnywaySchema = z.object({ location_id: uuidLike })

// This moves money, so withAuth only signs the caller in (401) and every other
// check runs here in its old order: the fee id (404), the body (400), the
// body's studio (assertLocationAccess), class_fees there (403), then the write.
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  const id = params?.id
  if (!uuidLike.safeParse(id).success) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const validation = await validateBody(request, ChargeAnywaySchema)
  if (!validation.ok) return validation.response
  const { location_id: locationId } = validation.data
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!canUseClassFees(user, locationId)) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  try {
    const r = await chargeAppealedFee(db, { locationId, feeId: id })
    if (!r.ok && r.reason === 'not_found') return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    if (!r.ok) return NextResponse.json({ success: false, code: 'not_appealed', error: 'This fee is not waiting on an appeal.' }, { status: 409 })
    return NextResponse.json({ success: true, data: { id, status: 'pending' } })
  } catch (err) {
    logError('class-fees', 'charge-anyway failed', { locationId, feeId: id, code: err?.code ?? null })
    return NextResponse.json({ success: false, error: 'Could not update the fee just now.' }, { status: 500 })
  }
})
