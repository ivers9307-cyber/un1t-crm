// FEES.3 — POST: a fresh appeal link for one fee, for staff to send the
// member themselves (works with the notice email off). Body { location_id }.
// Session auth + the class_fees permission at that studio; the studio's
// appeals switch must be on. Each call replaces the previous link.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { canUseClassFees } from '@/lib/class-fees-access'
import { issueAppealLink } from '@/lib/class-fees-member'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'

export const AppealLinkSchema = z.object({ location_id: uuidLike })

const REFUSED = {
  appeals_off: 'Appeals are switched off at this studio. Switch them on in the class-fees settings first.',
  not_appealable: 'This fee can no longer be appealed (it is charged, waived, being charged or already appealed).',
}

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  if (!uuidLike.safeParse(id).success) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const validation = await validateBody(request, AppealLinkSchema)
  if (!validation.ok) return validation.response
  const { location_id: locationId } = validation.data
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!canUseClassFees(user, locationId)) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  try {
    const r = await issueAppealLink(createServerClient(), { locationId, feeId: id })
    if (!r.ok && r.reason === 'not_found') return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    if (!r.ok) return NextResponse.json({ success: false, code: r.reason, error: REFUSED[r.reason] }, { status: 409 })
    return NextResponse.json({ success: true, data: { url: r.url } })
  } catch (err) {
    logError('class-fees', 'appeal link failed', { locationId, feeId: id, code: err?.code ?? null })
    return NextResponse.json({ success: false, error: 'Could not make an appeal link just now.' }, { status: 500 })
  }
}
