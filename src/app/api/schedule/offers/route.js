// src/app/api/schedule/offers/route.js
//
// REPLACE.1b — GET open "Offer to team" offers at one studio.
//   default (coach): offers the CALLER could take (CANDIDATES.1's tier ready
//     or advisory, the same rule as the push), that still need someone and
//     have not started. When, what, where only: no counts, no minimums
//     (COACHSCOPE.1). A check that could not be read still SHOWS the offer:
//     the claim re-checks, and hiding it would lose an offer the push may
//     already have announced.
//   view=manage (a manager AT the studio): the period's open offers with
//     their notice state, for the calendar and Manage mode. The SAME live
//     filter as the coach view (review 3): an offer whose shift has been
//     filled by hand, left a published roster or started is not shown, so the
//     dialog stops saying "Offered to the team" / Withdraw the moment the
//     shift gets its coach, not up to five minutes later when the sweep closes it.
// A studio that is not the caller's is 403 (a list route: the location comes
// from the query, not from a row).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, hasRoleAtLocation } from '@/lib/auth'
import { MANAGER_ROLES, isRealCalendarDate, uuidLike } from '@/lib/schemas'
import { listOpenOffers } from '@/lib/shift-offer-server'
import { loadBlockCandidates } from '@/lib/candidates-data'
import { offerIsFor, coachOfferRow, managerOfferRow, offerBlock } from '@/lib/shift-offer-notice'
import { offerStillNeeded } from '@shared/offer-to-team'
import { swapShiftHasStarted } from '@/lib/swap-cover'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  if (!locationId) return NextResponse.json({ success: false, error: 'location_id is required' }, { status: 400 })
  // Review 5 — a studio id is UUID-shaped, or nothing is read.
  if (!uuidLike.safeParse(locationId).success) {
    return NextResponse.json({ success: false, error: 'location_id must be a UUID' }, { status: 400 })
  }
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const manage = searchParams.get('view') === 'manage'
  const startDate = searchParams.get('start_date')
  const endDate = searchParams.get('end_date')
  if (manage && !hasRoleAtLocation(user, locationId, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  for (const [name, value] of [['start_date', startDate], ['end_date', endDate]]) {
    if (value && !isRealCalendarDate(value)) {
      return NextResponse.json({ success: false, error: `${name}: not a real date` }, { status: 400 })
    }
  }

  const db = createServerClient()
  const { offers, error } = await listOpenOffers(db, { locationId })
  if (error) return NextResponse.json({ success: false, error: 'Could not read offers' }, { status: 500 })
  const nowMs = Date.now()
  // Still live: published, still needs someone, not started. The sweep closes
  // anything else within five minutes; every list reads it live meanwhile.
  const live = (o) => {
    const b = o.shift_blocks
    if (!b || b.rosters?.status !== 'published' || !offerStillNeeded(b)) return false
    return !swapShiftHasStarted({ block_date: b.block_date, start_time: b.start_time }, nowMs, o.locations?.timezone ?? null)
  }

  if (manage) {
    const inRange = (d) => !!d && (!startDate || d >= startDate) && (!endDate || d <= endDate)
    return NextResponse.json({
      success: true,
      data: offers.filter((o) => live(o) && inRange(o.shift_blocks?.block_date)).map((o) => managerOfferRow(o, { nowMs })),
    })
  }

  const rows = []
  for (const o of offers) {
    if (!live(o)) continue
    const answer = await loadBlockCandidates(db, { block: offerBlock(o), audience: 'manager', publishedShiftsOnly: true })
    const mine = offerIsFor(answer, user.id)
    if (mine === null) {
      logWarn('shift-offer', 'coach offer list: eligibility unreadable; showing the offer (the claim re-checks)', { offerId: o.id, err: answer?.error?.message })
      rows.push(coachOfferRow(o))
    } else if (mine) {
      rows.push(coachOfferRow(o))
    }
  }
  return NextResponse.json({ success: true, data: rows })
}
