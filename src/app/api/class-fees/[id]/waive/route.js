// FEES.1 — POST waive one class fee before it is charged (or while it is
// scheduled for retry or outstanding). Body { location_id, reason }.
// Session auth + the class_fees permission at that studio. A fee that is not
// at this studio answers 404, never 403.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { assertLocationAccess } from '@/lib/auth'
import { withAuth } from '@/lib/with-auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { canUseClassFees } from '@/lib/class-fees-access'
import { waiveClassFee } from '@/lib/class-fees-run'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'

export const WaiveClassFeeSchema = z.object({
  location_id: uuidLike,
  reason: z.string().trim().min(1, 'Give a reason for the waiver').max(500),
})

// withAuth only signs the caller in. Every check after it runs by hand, in the
// order it always has: id 404, body 400, studio membership 403, class_fees at
// the body's studio 403.
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  const id = params?.id
  if (!uuidLike.safeParse(id).success) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const validation = await validateBody(request, WaiveClassFeeSchema)
  if (!validation.ok) return validation.response
  const { location_id: locationId, reason } = validation.data
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!canUseClassFees(user, locationId)) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  try {
    const r = await waiveClassFee(db, { locationId, feeId: id, actorId: user.id, reason })
    if (!r.ok && r.reason === 'not_found') return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    if (!r.ok) {
      return NextResponse.json({ success: false, code: 'not_waivable', error: 'This fee is being charged or has already been charged or waived, so it cannot be waived now.' }, { status: 409 })
    }
    return NextResponse.json({ success: true, data: { id, status: r.status } })
  } catch (err) {
    logError('class-fees', 'waive failed', { locationId, feeId: id, code: err?.code ?? null })
    return NextResponse.json({ success: false, error: 'Could not waive the fee just now.' }, { status: 500 })
  }
})
