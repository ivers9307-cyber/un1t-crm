// src/app/api/schedule/blocks/[id]/offer/route.js
//
// REPLACE.1b — POST: a manager offers this shift to the team. Manager at the
// shift's studio only (SCHEDROLES.1: 404 outside it, 403 for a member who is
// not a manager there). May it be offered is shared/offer-to-team.js
// offerRefusal (the rule the buttons use), with "started" read here on the
// studio clock (swapShiftHasStarted). The offer is live at once; the push
// goes through processOffer (07:00-22:00 only; the */5 arm sends it from 07:00).
// A second open offer for the same shift is refused by the partial unique
// index (mig 641): 409 already_offered.

import { NextResponse, after } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { MANAGER_ROLES, uuidLike } from '@/lib/schemas'
import { readOfferBlock, createOffer, processOffer } from '@/lib/shift-offer-server'
import { offerRefusal, OFFER_REFUSALS } from '@shared/offer-to-team'
import { swapShiftHasStarted } from '@/lib/swap-cover'
import { inStaffPushHours } from '@/lib/staff-push-hours'
import { dublinTodayStr } from '@/lib/dublin-time'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  // Coarse only: the real decision is at the shift's studio.
  if (!hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Only a manager can offer a shift to the team' }, { status: 403 })
  }
  // A malformed id is an id that does not exist: 404, nothing read.
  if (!uuidLike.safeParse(params?.id).success) {
    return NextResponse.json({ success: false, error: 'Shift not found' }, { status: 404 })
  }

  const db = createServerClient()
  const { block, error } = await readOfferBlock(db, params.id)
  if (error) return NextResponse.json({ success: false, error: 'Could not read the shift' }, { status: 500 })
  if (!block) return NextResponse.json({ success: false, error: 'Shift not found' }, { status: 404 })
  const notHere = assertLocationAccessOr404(user, block.location_id)
  if (notHere) return notHere
  if (!hasRoleAtLocation(user, block.location_id, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Only a manager at this studio can offer this shift' }, { status: 403 })
  }

  const nowMs = Date.now()
  const tz = block.locations?.timezone ?? null
  const started = swapShiftHasStarted({ block_date: block.block_date, start_time: block.start_time }, nowMs, tz)
  const refusal = offerRefusal(block, { todayIso: dublinTodayStr(), started })
  if (refusal) return NextResponse.json({ success: false, code: refusal, error: OFFER_REFUSALS[refusal] }, { status: 409 })

  const created = await createOffer(db, { block, actorId: user.id })
  if (created.code === 'already_offered') {
    return NextResponse.json({ success: false, code: 'already_offered', error: OFFER_REFUSALS.already_offered }, { status: 409 })
  }
  if (created.error || !created.offer) {
    logError('shift-offer', 'offer insert failed', { blockId: block.id, err: created.error?.message })
    return NextResponse.json({ success: false, error: 'Could not offer the shift' }, { status: 500 })
  }

  after(() => processOffer(db, created.offer, { nowMs })
    .catch((err) => logError('shift-offer', 'offer broadcast failed; the */5 arm retries it', { offerId: created.offer.id, err: err?.message })))

  return NextResponse.json({
    success: true,
    data: { offer_id: created.offer.id, notice: inStaffPushHours(nowMs, tz) ? 'now' : 'morning' },
  }, { status: 201 })
}
