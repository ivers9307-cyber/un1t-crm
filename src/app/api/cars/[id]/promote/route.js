// /api/cars/[id]/promote — move a car forward through the workflow.
//
// Body: { to: 'pending' | 'completed' }
//
// Promotion to 'pending'  — manual step the operator triggers when
//                            a buyer is in play. No checks beyond
//                            the car existing.
// Promotion to 'completed' — gated by completionGaps() so the
//                            checklist of invoices / VAT refund /
//                            buyer details / Xero invoice is enforced
//                            server-side. UI shows the same checks
//                            inline; the API is the security boundary.
//
// withAuth only signs the caller in (the same 401); the coarse permission
// (403), the body (400), the car (404), its studio (404) and the permission
// there (403) keep their order here, and the write is unchanged.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { completionGaps } from '@/lib/cars'

const PromoteSchema = z.object({
  to: z.enum(['new', 'pending', 'completed']),
})

export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  if (!hasPermissionAtAnyLocation(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const validation = await validateBody(request, PromoteSchema)
  if (!validation.ok) return validation.response
  const { to } = validation.data

  const { data: car } = await db
    .from('cars')
    .select('*, car_documents(doc_type, xero_sent_at)')
    .eq('id', params.id)
    .single()
  if (!car) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const guard = assertLocationAccessOr404(user, car.location_id)
  if (guard) return guard
  // ROLESWEEP.1b — judged at the car's location, not the caller's active studio.
  if (!hasPermissionForLocation(user, car.location_id, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  if (to === 'completed') {
    // BCA gate (Phase 3) — fetch the car's location feature flag + a
    // boolean for "is there an active non-error BCA submission for
    // this car". Both default to false so locations without the
    // feature stay green via completionGaps's defensive defaults.
    const [{ data: location }, { count: activeBcaCount }] = await Promise.all([
      db.from('locations').select('features').eq('id', car.location_id).single(),
      db.from('car_bca_submissions')
        .select('id', { count: 'exact', head: true })
        .eq('car_id', car.id)
        .is('superseded_at', null)
        .not('postmark_message_id', 'is', null),
    ])
    const bcaEnabled = location?.features?.bca_submit === true
    const hasActiveBcaSubmission = (activeBcaCount || 0) > 0

    const gaps = completionGaps(car, { bcaEnabled, hasActiveBcaSubmission })
    if (gaps.length) {
      return NextResponse.json({
        success: false,
        error: 'Cannot complete yet — outstanding items: ' + gaps.join(', '),
        gaps,
      }, { status: 400 })
    }
  }

  const updates = { status: to }
  if (to === 'completed') updates.completed_at = new Date().toISOString()
  if (to !== 'completed') updates.completed_at = null

  const { data, error } = await db
    .from('cars')
    .update(updates)
    .eq('id', params.id)
    .select()
    .single()
  if (error) {
    logError('cars', 'promote failed', { carId: params.id, to, err: error })
    return NextResponse.json({ success: false, error: 'Could not move the car on. Refresh and try again.' }, { status: 400 })
  }
  return NextResponse.json({ success: true, data })
})
