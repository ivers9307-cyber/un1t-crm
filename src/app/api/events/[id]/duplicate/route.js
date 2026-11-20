// /api/events/[id]/duplicate — HOSTSERIES.1
//
// POST — staff copy an event to a new date as a draft (duplicateEvent, the
// same lib the host route uses). Manager+ holding `races` AT THE EVENT'S
// studio; an event outside the caller's studios is 404 (never 403, so ids
// cannot be enumerated).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { assertLocationAccessOr404, hasRoleAtLocation } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { MANAGER_ROLES, uuidLike } from '@/lib/schemas'
import { duplicateEvent, DUPLICATE_ERRORS } from '@/lib/event-duplicate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const DuplicateBodySchema = z.object({
  race_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict()

const notFound = () => NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

// withAuth only signs the caller in: `races` is first checked at ANY studio
// (not the active one), then at the event's, so both stay here in order.
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  if (!hasPermissionAtAnyLocation(user, 'races')) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  if (!uuidLike.safeParse(params?.id).success) return notFound()

  const { data: race } = await db.from('race_events').select('id, location_id').eq('id', params.id).maybeSingle()
  if (!race?.location_id) return notFound()
  const guard = assertLocationAccessOr404(user, race.location_id)
  if (guard) return guard
  if (!hasPermissionForLocation(user, race.location_id, 'races') || !hasRoleAtLocation(user, race.location_id, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const validation = await validateBody(request, DuplicateBodySchema)
  if (!validation.ok) return validation.response

  const result = await duplicateEvent(db, { sourceId: race.id, raceDate: validation.data.race_date })
  if (!result.ok) {
    const status = result.error === DUPLICATE_ERRORS.NOT_FOUND ? 404 : 500
    return NextResponse.json({ success: false, error: result.message, code: result.error }, { status })
  }
  return NextResponse.json({ success: true, data: result.event })
})
