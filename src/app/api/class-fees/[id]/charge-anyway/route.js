// FEES.3 — POST: charge an appealed fee after all. It goes back to pending,
// due now; the next hourly run charges it. Body { location_id }.
// Session auth + the class_fees permission at that studio; 404 for a fee at
// another studio.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { canUseClassFees } from '@/lib/class-fees-access'
import { chargeAppealedFee } from '@/lib/class-fees-member'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'

export const ChargeAnywaySchema = z.object({ location_id: uuidLike })

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  if (!uuidLike.safeParse(id).success) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const validation = await validateBody(request, ChargeAnywaySchema)
  if (!validation.ok) return validation.response
  const { location_id: locationId } = validation.data
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!canUseClassFees(user, locationId)) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  try {
    const r = await chargeAppealedFee(createServerClient(), { locationId, feeId: id })
    if (!r.ok && r.reason === 'not_found') return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    if (!r.ok) return NextResponse.json({ success: false, code: 'not_appealed', error: 'This fee is not waiting on an appeal.' }, { status: 409 })
    return NextResponse.json({ success: true, data: { id, status: 'pending' } })
  } catch (err) {
    logError('class-fees', 'charge-anyway failed', { locationId, feeId: id, code: err?.code ?? null })
    return NextResponse.json({ success: false, error: 'Could not update the fee just now.' }, { status: 500 })
  }
}
