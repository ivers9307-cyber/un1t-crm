// FEES.1 — POST "Retry charge" from the member profile: one charge attempt
// for each of the contact's fees that are scheduled for retry or outstanding
// at this studio, on their default card in un1t.online. Body
// { location_id, contact_id }. Session auth + the class_fees permission at
// that studio; un1t.online writes must be on there.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { canUseClassFees } from '@/lib/class-fees-access'
import { retryContactFees } from '@/lib/class-fees-run'
import { checkRateLimit } from '@/lib/rate-limit'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const maxDuration = 60

export const RetryClassFeesSchema = z.object({
  location_id: uuidLike,
  contact_id: uuidLike,
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const validation = await validateBody(request, RetryClassFeesSchema)
  if (!validation.ok) return validation.response
  const { location_id: locationId, contact_id: contactId } = validation.data
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!canUseClassFees(user, locationId)) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  const db = createServerClient()
  const slot = await checkRateLimit(db, `class-fees-retry:${locationId}:${contactId}`, { max: 3, windowMs: 60_000 })
  if (!slot.allowed) return NextResponse.json({ success: false, error: 'A retry for this member just ran. Wait a minute and try again.' }, { status: 429 })
  try {
    const { outcomes } = await retryContactFees(db, { locationId, contactId, actor: { id: user.id } })
    return NextResponse.json({ success: true, data: { outcomes } })
  } catch (err) {
    logError('class-fees', 'retry failed', { locationId, code: err?.code ?? null })
    return NextResponse.json({ success: false, error: 'Could not retry the charge just now.' }, { status: 500 })
  }
}
