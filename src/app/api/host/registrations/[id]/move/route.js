// /api/host/registrations/[id]/move — EVENT-MOVE.2
//
// POST — a host moves ONE of their own entries to another of their OWN events.
// Same lib and dialog as the staff route (/api/event-registrations/[id]/move);
// the host fence is allowedEventIds (their own events) on top of the lib's
// same-payee rule, so it is enforced twice. A host cannot move an entry that is
// still awaiting payment (they cannot collect or waive money), so
// pending_payment is refused here, before the body is read.
//
// Status codes: 401 not a host session; 404 an entry that is missing or on
// another host's event (ids cannot be enumerated across hosts), or a target
// outside the host's events (the lib's not_found); 400 pending_payment, a bad
// body or a rule that refused; 409 wave_full (with spots_left) or conflict;
// 500 a read or write that FAILED (load_failed, write_failed).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentHost } from '@/lib/host-auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { moveRegistration, MOVE_ERRORS, MOVE_ERROR_MESSAGES } from '@/lib/registration-move'
import { resolveHostMoveContext } from '@/lib/host-move-session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const HostMoveSchema = z.object({
  target_event_id: uuidLike,
  target_wave_id: uuidLike.nullable().optional(),
  notify: z.boolean().optional().default(true),
  note: z.string().trim().max(1000).nullable().optional(),
  force: z.boolean().optional().default(false),
})

// Everything not listed is a rule that refused the move: 400 (staff route's map).
const STATUS_FOR = Object.freeze({
  [MOVE_ERRORS.NOT_FOUND]: 404,
  [MOVE_ERRORS.WAVE_FULL]: 409,
  [MOVE_ERRORS.CONFLICT]: 409,
  [MOVE_ERRORS.LOAD_FAILED]: 500,
  [MOVE_ERRORS.WRITE_FAILED]: 500,
})

const PENDING_PAYMENT = 'pending_payment'
const PENDING_PAYMENT_MESSAGE = 'This entry is awaiting payment. It can move once it is paid.'

/** A refusal with its code and the dialog's plain-English copy. */
function refusal(code, extra = {}) {
  return NextResponse.json({
    success: false,
    error: code,
    message: MOVE_ERROR_MESSAGES[code] || 'The move could not be completed.',
    ...extra,
  }, { status: STATUS_FOR[code] || 400 })
}

export async function POST(request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const ctx = await resolveHostMoveContext(session, params.id)
  if (ctx.response) return ctx.response
  const { db, registration, allowedEventIds, actor } = ctx

  if (registration.status === PENDING_PAYMENT) {
    return NextResponse.json({ success: false, error: PENDING_PAYMENT, message: PENDING_PAYMENT_MESSAGE }, { status: 400 })
  }

  const validation = await validateBody(request, HostMoveSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const result = await moveRegistration(db, {
    registrationId: params.id,
    targetEventId: body.target_event_id,
    targetWaveId: body.target_wave_id || null,
    actor,
    note: body.note || null,
    notify: body.notify,
    force: body.force,
    // The host fence: only this host's own events (a target outside it is
    // the lib's not_found, 404).
    allowedEventIds,
    // The event this route authorised on: if the entry moved between this
    // read and the lib's, the lib answers conflict (409) before any write.
    expectedSourceEventId: registration.race_event_id,
  })
  if (!result.ok) {
    return refusal(result.error, result.spots_left !== undefined ? { spots_left: result.spots_left } : {})
  }
  return NextResponse.json({ success: true, data: { move: result.move, registration: result.registration, notified: result.notified === true } })
}
