// /api/events/[id]/pair-solos — FINDTEAM.5
//
// POST — pair two to eight solo entrants ("Find me a team") on this event into
// a NEW team entry. Manager+ holding `races` at the event's studio. The rules
// and every write live in src/lib/registration-placement.js; this route holds
// the gate, the body, the status mapping and the placed email kick-off.
//
// Status codes: 401 signed out; 403 races held nowhere, or no manager role /
// no races at the event's studio; 404 an event the caller may not see (missing,
// or at a studio they cannot see) or a registration not on it; 400 a bad body,
// too_few, mixed_waves, invalid_wave; 409 a row in the wrong state, a taken
// team name, or wave_full (with code and spots_left; resend with force: true);
// 500 a read or write that FAILED. Never reads race_events.find_team.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { MANAGER_ROLES, uuidLike } from '@/lib/schemas'
import { logError } from '@/lib/log'
import { pairSolos, PLACEMENT_ERRORS, PLACEMENT_ERROR_MESSAGES } from '@/lib/registration-placement'
import { sendPlacedEmail } from '@/lib/race-confirmations'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const PairSolosSchema = z.object({
  registration_ids: z.array(uuidLike).min(2).max(8),
  team_name: z.string().trim().min(1).max(80),
  wave_id: uuidLike.nullable().optional(),
  force: z.boolean().optional().default(false),
})

// Everything not listed is a rule that refused: 400.
const STATUS_FOR = Object.freeze({
  [PLACEMENT_ERRORS.NOT_FOUND]: 404,
  [PLACEMENT_ERRORS.WRONG_EVENT]: 404,
  [PLACEMENT_ERRORS.NOT_PAID]: 409,
  [PLACEMENT_ERRORS.ALREADY_PLACED]: 409,
  [PLACEMENT_ERRORS.NOT_SOLO]: 409,
  [PLACEMENT_ERRORS.NO_MEMBER_ROW]: 409,
  [PLACEMENT_ERRORS.TEAM_NAME_TAKEN]: 409,
  [PLACEMENT_ERRORS.WAVE_FULL]: 409,
  [PLACEMENT_ERRORS.LOAD_FAILED]: 500,
  [PLACEMENT_ERRORS.WRITE_FAILED]: 500,
})

const notFound = () => NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
const forbidden = () => NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

function refusal(code, extra = {}) {
  return NextResponse.json({
    success: false,
    error: code,
    message: PLACEMENT_ERROR_MESSAGES[code] || 'The entrants could not be paired.',
    ...extra,
  }, { status: STATUS_FOR[code] || 400 })
}

/** The fields of a refusal the dialog can use (which ids, how many places). */
function refusalExtras(result) {
  const extra = {}
  if (result.error === PLACEMENT_ERRORS.WAVE_FULL) extra.code = PLACEMENT_ERRORS.WAVE_FULL
  if (result.spots_left !== undefined) extra.spots_left = result.spots_left
  if (result.ids) extra.ids = result.ids
  if (result.stage) extra.stage = result.stage
  if (result.registrationId) extra.registration_id = result.registrationId
  return extra
}

/** Best-effort: one placed email per person; nothing here changes the response. */
async function emailPlaced(db, registrationIds, eventId) {
  for (const registrationId of registrationIds || []) {
    try {
      await sendPlacedEmail({ db, registrationId })
    } catch (e) {
      logError('pair-solos', 'placed email threw; the entrant is placed but was not told', { err: e, registrationId, eventId })
    }
  }
}

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermissionAtAnyLocation(user, 'races')) return forbidden()
  if (!uuidLike.safeParse(params.id).success) return notFound()

  const db = createServerClient()
  const { data: event, error: readErr } = await db
    .from('race_events').select('id, location_id').eq('id', params.id).maybeSingle()
  if (readErr) {
    logError('pair-solos', 'event read failed', { err: readErr, eventId: params.id })
    return refusal(PLACEMENT_ERRORS.LOAD_FAILED)
  }
  if (!event || !event.location_id) return notFound()
  const guard = assertLocationAccessOr404(user, event.location_id)
  if (guard) return guard
  if (!hasPermissionForLocation(user, event.location_id, 'races') || !hasRoleAtLocation(user, event.location_id, MANAGER_ROLES)) {
    return forbidden()
  }

  const validation = await validateBody(request, PairSolosSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const result = await pairSolos(db, {
    raceEventId: event.id,
    registrationIds: body.registration_ids,
    teamName: body.team_name,
    waveId: body.wave_id || null,
    force: body.force,
    // Under impersonation the REAL caller is recorded (as the move route does).
    byProfileId: user.impersonatingFrom?.masterId || user.id,
    now: new Date(),
  })
  // A partial flip failure still placed some people: they get their email.
  await emailPlaced(db, result.placedIds, event.id)
  if (!result.ok) return refusal(result.error, refusalExtras(result))
  return NextResponse.json({ success: true, data: { registration_id: result.registrationId } })
}
