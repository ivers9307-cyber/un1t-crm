// FEES.3 — POST: a fresh appeal link for one fee, for staff to send the
// member themselves (works with the notice email off). Body { location_id }.
// Session auth + the class_fees permission at that studio; the studio's
// appeals switch must be on. Each call replaces the previous link.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { assertLocationAccess } from '@/lib/auth'
import { withAuth } from '@/lib/with-auth'
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

// withAuth only signs the caller in. Every check after it runs by hand, in the
// order it always has: id 404, body 400, studio membership 403, class_fees at
// the body's studio 403.
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  const id = params?.id
  if (!uuidLike.safeParse(id).success) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const validation = await validateBody(request, AppealLinkSchema)
  if (!validation.ok) return validation.response
  const { location_id: locationId } = validation.data
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!canUseClassFees(user, locationId)) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  try {
    const r = await issueAppealLink(db, { locationId, feeId: id })
    if (!r.ok && r.reason === 'not_found') return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    if (!r.ok) return NextResponse.json({ success: false, code: r.reason, error: REFUSED[r.reason] }, { status: 409 })
    return NextResponse.json({ success: true, data: { url: r.url } })
  } catch (err) {
    logError('class-fees', 'appeal link failed', { locationId, feeId: id, code: err?.code ?? null })
    return NextResponse.json({ success: false, error: 'Could not make an appeal link just now.' }, { status: 500 })
  }
})
