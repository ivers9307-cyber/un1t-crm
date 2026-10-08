// /api/event-registrations/[id]/move-targets — EVENT-MOVE.1
//
// GET — the events this entry may move to, with per-wave spots and the price
// gap. Staff-only (it shows capacity): manager+ holding `races` at the
// source studio; targets are limited to studios where the caller holds the
// same, which is exactly the gate POST /move applies to a target. Never
// public. A failed read is a 500, never a 404.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation, getUserLocationIds } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES, uuidLike } from '@/lib/schemas'
import { readRegistrationForMove, listMoveTargets, MOVE_ERRORS, MOVE_ERROR_MESSAGES } from '@/lib/registration-move'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const notFound = () => NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
const forbidden = () => NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

/** May the caller MOVE an entry at this studio? (POST /move's gate.) */
function canMoveAt(user, locationId) {
  return !!locationId
    && hasPermissionForLocation(user, locationId, 'races')
    && hasRoleAtLocation(user, locationId, MANAGER_ROLES)
}

export async function GET(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermissionAtAnyLocation(user, 'races')) return forbidden()
  if (!uuidLike.safeParse(params.id).success) return notFound()

  const db = createServerClient()
  const { registration: reg, error: readErr } = await readRegistrationForMove(db, params.id)
  if (readErr) {
    return NextResponse.json({
      success: false, error: MOVE_ERRORS.LOAD_FAILED, message: MOVE_ERROR_MESSAGES[MOVE_ERRORS.LOAD_FAILED],
    }, { status: 500 })
  }
  if (!reg) return notFound()
  const sourceLocationId = reg.race?.location_id
  if (!sourceLocationId) return notFound()
  const guard = assertLocationAccessOr404(user, sourceLocationId)
  if (guard) return guard
  if (!canMoveAt(user, sourceLocationId)) return forbidden()

  const result = await listMoveTargets(db, { registrationId: params.id, allowedLocationIds: getUserLocationIds(user) })
  if (!result.ok) {
    return NextResponse.json({
      success: false, error: result.error,
      message: MOVE_ERROR_MESSAGES[result.error] || 'The events could not be loaded.',
    }, { status: result.error === MOVE_ERRORS.NOT_FOUND ? 404 : 500 })
  }
  // Only studios where the caller may MOVE things (same gate as POST /move):
  // membership alone (getUserLocationIds) would offer a target the move
  // would then refuse with a 403.
  const targets = result.targets.filter((t) => canMoveAt(user, t.location_id))
  return NextResponse.json({ success: true, data: { entry: result.entry, source: result.source, targets } })
}
