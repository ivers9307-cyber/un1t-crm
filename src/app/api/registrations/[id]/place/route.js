// /api/registrations/[id]/place — FINDTEAM.5
//
// POST — place a solo entrant ("Find me a team") into an existing team entry
// on the same event. Manager+ holding `races` at the event's studio. The rules
// and every write live in src/lib/registration-placement.js; this route holds
// the gate, the body, the status mapping and the placed email kick-off.
//
// Status codes: 401 signed out; 403 races held nowhere, or no manager role /
// no races at the event's studio; 404 an id the caller may not see (missing,
// or at a studio they cannot see, so ids cannot be enumerated) or a target on
// another event; 400 a bad body; 409 a row in the wrong state (not_paid,
// already_placed, not_solo, target_not_live); 500 a read or write that FAILED.
// Never reads race_events.find_team: switching the feature off must not strand
// a solo who already registered.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { MANAGER_ROLES, uuidLike } from '@/lib/schemas'
import { logError } from '@/lib/log'
import { placeSoloIntoTeam, PLACEMENT_ERRORS, PLACEMENT_ERROR_MESSAGES } from '@/lib/registration-placement'
import { sendPlacedEmail } from '@/lib/race-confirmations'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const PlaceSchema = z.object({
  team_registration_id: uuidLike,
})

// Everything not listed is a rule that refused: 400.
const STATUS_FOR = Object.freeze({
  [PLACEMENT_ERRORS.NOT_FOUND]: 404,
  [PLACEMENT_ERRORS.WRONG_EVENT]: 404,
  [PLACEMENT_ERRORS.NOT_PAID]: 409,
  [PLACEMENT_ERRORS.ALREADY_PLACED]: 409,
  [PLACEMENT_ERRORS.NOT_SOLO]: 409,
  [PLACEMENT_ERRORS.TARGET_NOT_LIVE]: 409,
  [PLACEMENT_ERRORS.NO_MEMBER_ROW]: 409,
  [PLACEMENT_ERRORS.LOAD_FAILED]: 500,
  [PLACEMENT_ERRORS.WRITE_FAILED]: 500,
})

const notFound = () => NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
const forbidden = () => NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

function refusal(code, extra = {}) {
  return NextResponse.json({
    success: false,
    error: code,
    message: PLACEMENT_ERROR_MESSAGES[code] || 'The entrant could not be placed.',
    ...extra,
  }, { status: STATUS_FOR[code] || 400 })
}

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermissionAtAnyLocation(user, 'races')) return forbidden()
  if (!uuidLike.safeParse(params.id).success) return notFound()

  const db = createServerClient()
  const { data: solo, error: readErr } = await db
    .from('race_registrations')
    .select('id, race_event_id, race:race_event_id ( id, location_id )')
    .eq('id', params.id)
    .maybeSingle()
  if (readErr) {
    logError('registration-place', 'solo registration read failed', { err: readErr, registrationId: params.id })
    return refusal(PLACEMENT_ERRORS.LOAD_FAILED)
  }
  if (!solo) return notFound()
  const locationId = solo.race?.location_id
  if (!locationId) return notFound()
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard
  if (!hasPermissionForLocation(user, locationId, 'races') || !hasRoleAtLocation(user, locationId, MANAGER_ROLES)) {
    return forbidden()
  }

  const validation = await validateBody(request, PlaceSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const result = await placeSoloIntoTeam(db, {
    soloRegistrationId: params.id,
    teamRegistrationId: body.team_registration_id,
    // Under impersonation the REAL caller is recorded (as the move route does).
    byProfileId: user.impersonatingFrom?.masterId || user.id,
    now: new Date(),
  })
  if (!result.ok) return refusal(result.error, result.stage ? { stage: result.stage } : {})

  // Best-effort: the placement stands whatever the email does.
  try {
    await sendPlacedEmail({ db, registrationId: params.id })
  } catch (e) {
    logError('registration-place', 'placed email threw; the entrant is placed but was not told', { err: e, registrationId: params.id })
  }
  return NextResponse.json({ success: true, data: { placed: true } })
}
