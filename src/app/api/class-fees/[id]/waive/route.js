// FEES.1 — POST waive one class fee before it is charged (or while it is
// scheduled for retry or outstanding). Body { location_id, reason }.
// Session auth + the class_fees permission at that studio. A fee that is not
// at this studio answers 404, never 403.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
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

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  if (!uuidLike.safeParse(id).success) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const validation = await validateBody(request, WaiveClassFeeSchema)
  if (!validation.ok) return validation.response
  const { location_id: locationId, reason } = validation.data
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!canUseClassFees(user, locationId)) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  const db = createServerClient()
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
}
