// /api/host/registrations/[id]/move-targets — EVENT-MOVE.2
//
// GET — the host's OWN upcoming events this entry may move to, with per-wave
// spots and the price gap. Host-only (it shows capacity); never public. The
// entry must sit on one of the host's events (404 otherwise), and targets are
// fenced by allowedEventIds (the host's own events), not by studio:
// allowedLocationIds is null because a host's events can sit at any studio of
// the org. A failed read is a 500, never a 404.

import { NextResponse } from 'next/server'
import { getCurrentHost } from '@/lib/host-auth'
import { listMoveTargets, MOVE_ERRORS, MOVE_ERROR_MESSAGES } from '@/lib/registration-move'
import { resolveHostMoveContext } from '@/lib/host-move-session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const ctx = await resolveHostMoveContext(session, params.id)
  if (ctx.response) return ctx.response
  const { db, allowedEventIds } = ctx

  const result = await listMoveTargets(db, { registrationId: params.id, allowedEventIds, allowedLocationIds: null })
  if (!result.ok) {
    return NextResponse.json({
      success: false, error: result.error,
      message: MOVE_ERROR_MESSAGES[result.error] || 'The events could not be loaded.',
    }, { status: result.error === MOVE_ERRORS.NOT_FOUND ? 404 : 500 })
  }
  return NextResponse.json({ success: true, data: { entry: result.entry, source: result.source, targets: result.targets } })
}
