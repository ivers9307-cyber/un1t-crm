// /api/event-registrations/[id]/move — EVENT-MOVE.1
//
// POST — move an entry to another event (and wave). Manager+ holding `races`
// at BOTH the source and the target studio. Never moves money. See
// src/lib/registration-move.js for the rules and
// docs/superpowers/specs/2026-10-08-event-entry-move-design.md.
//
// Status codes: 401 signed out; 403 races held nowhere, or no manager role /
// no races at a studio the caller can see; 404 an id the caller may not see
// (entry or target event, missing or at another studio, so ids cannot be
// enumerated); 400 a bad body or a rule that refused; 409 wave_full (with
// spots_left) or conflict; 500 a read or write that FAILED (load_failed,
// write_failed), never dressed up as a 404.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { MANAGER_ROLES, uuidLike } from '@/lib/schemas'
import { logError } from '@/lib/log'
import { readRegistrationForMove, moveRegistration, MOVE_ERRORS, MOVE_ERROR_MESSAGES } from '@/lib/registration-move'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const MoveSchema = z.object({
  target_event_id: uuidLike,
  target_wave_id: uuidLike.nullable().optional(),
  notify: z.boolean().optional().default(true),
  note: z.string().trim().max(1000).nullable().optional(),
  force: z.boolean().optional().default(false),
})

// Everything not listed is a rule that refused the move: 400.
const STATUS_FOR = Object.freeze({
  [MOVE_ERRORS.NOT_FOUND]: 404,
  [MOVE_ERRORS.WAVE_FULL]: 409,
  [MOVE_ERRORS.CONFLICT]: 409,
  [MOVE_ERRORS.LOAD_FAILED]: 500,
  [MOVE_ERRORS.WRITE_FAILED]: 500,
})

const notFound = () => NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
const forbidden = () => NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

// load_failed's own copy is about the entry; a failed TARGET read keeps the
// code and says which row could not be read.
const TARGET_LOAD_FAILED_MESSAGE = 'The target event could not be read. Try again.'

/** A refusal with its code and the dialog's plain-English copy. */
function refusal(code, extra = {}, message = null) {
  return NextResponse.json({
    success: false,
    error: code,
    message: message || MOVE_ERROR_MESSAGES[code] || 'The move could not be completed.',
    ...extra,
  }, { status: STATUS_FOR[code] || 400 })
}

/**
 * Who moved it. Under impersonation (a master acting as someone, see
 * getCurrentUser's impersonatingFrom) the REAL caller is recorded: their id,
 * and "<master> as <user>" so the history reads true.
 */
function actorFor(user) {
  const userName = user.full_name || user.email || 'staff'
  const imp = user.impersonatingFrom
  if (imp?.masterId) {
    return { type: 'staff', id: imp.masterId, name: `${imp.masterName || imp.masterEmail || 'master'} as ${userName}` }
  }
  return { type: 'staff', id: user.id, name: userName }
}

/**
 * The gate at one studio: 404 if the caller cannot see it (or the row has no
 * studio to judge), 403 without `races` and a manager role there.
 */
function refuseAt(user, locationId) {
  if (!locationId) return notFound()
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard
  if (!hasPermissionForLocation(user, locationId, 'races') || !hasRoleAtLocation(user, locationId, MANAGER_ROLES)) {
    return forbidden()
  }
  return null
}

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermissionAtAnyLocation(user, 'races')) return forbidden()
  // A malformed id cannot name a row; reading it would only fail as 22P02.
  if (!uuidLike.safeParse(params.id).success) return notFound()

  const db = createServerClient()
  const { registration: reg, error: readErr } = await readRegistrationForMove(db, params.id)
  if (readErr) return refusal(MOVE_ERRORS.LOAD_FAILED)
  if (!reg) return notFound()
  const sourceRefusal = refuseAt(user, reg.race?.location_id)
  if (sourceRefusal) return sourceRefusal

  const validation = await validateBody(request, MoveSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  // The target studio is judged the same way, before the lib runs. 404, so
  // event ids cannot be enumerated through this route; a FAILED read is 500.
  const { data: target, error: targetErr } = await db
    .from('race_events').select('id, location_id').eq('id', body.target_event_id).maybeSingle()
  if (targetErr) {
    logError('event-registration-move', 'target event read failed', { err: targetErr, registrationId: params.id, targetEventId: body.target_event_id })
    return refusal(MOVE_ERRORS.LOAD_FAILED, {}, TARGET_LOAD_FAILED_MESSAGE)
  }
  if (!target) return notFound()
  const targetRefusal = refuseAt(user, target.location_id)
  if (targetRefusal) return targetRefusal

  const result = await moveRegistration(db, {
    registrationId: params.id,
    targetEventId: body.target_event_id,
    targetWaveId: body.target_wave_id || null,
    actor: actorFor(user),
    note: body.note || null,
    notify: body.notify,
    force: body.force,
    // The host fence; staff are fenced by the two studio gates above.
    allowedEventIds: null,
    // The event this route authorised on: if the entry moved between this
    // read and the lib's, the lib answers conflict (409) before any write.
    expectedSourceEventId: reg.race_event_id,
  })
  if (!result.ok) {
    return refusal(result.error, result.spots_left !== undefined ? { spots_left: result.spots_left } : {})
  }
  return NextResponse.json({ success: true, data: { move: result.move, registration: result.registration, notified: result.notified === true } })
}
