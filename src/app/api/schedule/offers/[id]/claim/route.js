// src/app/api/schedule/offers/[id]/claim/route.js
//
// REPLACE.1b — POST: a coach takes an offered shift. First to claim gets it;
// claim_shift_offer (mig 641) is the lock that decides.
//   - the caller must belong to the offer's studio (404 otherwise: the id is
//     never confirmed to an outsider, nor is a malformed one read);
//   - the offer is open, the shift has not started (swapShiftHasStarted, the
//     one predicate, studio clock);
//   - CANDIDATES.1's facts for the shift (loadBlockCandidates): approved leave
//     that day or a live overlapping shift in the organisation refuses (they
//     cannot be in two places); an unreadable answer is 503, never a claim on
//     a guess. Unavailability does not block: claiming says they are free;
//   - then the RPC, which re-checks membership, "already on it", published
//     and still needed under its locks; its refusals map through
//     offerClaimRpcError.
// On success: one roster_change_log row (via 'offer'), stamped at once (a
// self change tells nobody), and the managers' "taken" notice through
// processOffer (07:00-22:00 only; the */5 arm sends it otherwise).

import { NextResponse, after } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { uuidLike } from '@/lib/schemas'
import { readOffer, claimOffer, processOffer } from '@/lib/shift-offer-server'
import { loadBlockCandidates } from '@/lib/candidates-data'
import { offerClaimRefusal, offerClaimRpcError, offerBlock } from '@/lib/shift-offer-notice'
import { swapShiftHasStarted } from '@/lib/swap-cover'
import { liveAssignments } from '@/lib/roster'
import { logRosterChange, markChangesNotified } from '@/lib/roster-change-log'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CLOSED_WORDS = {
  claimed: 'Someone else has just taken this shift.',
  withdrawn: 'This shift is no longer on offer.',
  expired: 'This shift is no longer on offer.',
  filled: 'This shift no longer needs cover.',
}

export async function POST(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  // A malformed id is an id that does not exist: 404, nothing read.
  if (!uuidLike.safeParse(params?.id).success) {
    return NextResponse.json({ success: false, error: 'Offer not found' }, { status: 404 })
  }

  const db = createServerClient()
  const { offer, error } = await readOffer(db, params.id)
  if (error) return NextResponse.json({ success: false, error: 'Could not read the offer' }, { status: 500 })
  if (!offer) return NextResponse.json({ success: false, error: 'Offer not found' }, { status: 404 })
  const notHere = assertLocationAccessOr404(user, offer.location_id)
  if (notHere) return notHere

  // Review 5 — the same coach's second tap on an offer they already won.
  if (offer.status === 'claimed' && offer.claimed_by === user.id) {
    return NextResponse.json({ success: false, error: 'You already have this shift.' }, { status: 409 })
  }
  if (offer.status !== 'open') {
    return NextResponse.json({ success: false, error: CLOSED_WORDS[offer.status] || 'This shift is no longer on offer.' }, { status: 409 })
  }
  const block = offerBlock(offer)
  const nowMs = Date.now()
  if (swapShiftHasStarted({ block_date: block.block_date, start_time: block.start_time }, nowMs, offer.locations?.timezone ?? null)) {
    return NextResponse.json({ success: false, error: 'This shift has already started.' }, { status: 409 })
  }

  // Review 4 (owner decision) — published shifts only: a coach is never
  // refused over a draft they cannot see (the push and the list agree).
  const answer = await loadBlockCandidates(db, { block, audience: 'manager', publishedShiftsOnly: true })
  const blocked = offerClaimRefusal(answer, {
    profileId: user.id,
    liveOnBlockIds: liveAssignments(block.shift_assignments).map((a) => a.profile_id),
  })
  if (blocked) return NextResponse.json({ success: false, code: blocked.code, error: blocked.error }, { status: blocked.status })

  const { result, error: rpcErr } = await claimOffer(db, { offerId: offer.id, profileId: user.id })
  if (rpcErr) {
    const m = offerClaimRpcError(rpcErr)
    if (m.status === 500) logError('shift-offer', 'claim_shift_offer failed', { offerId: offer.id, err: rpcErr.message })
    return NextResponse.json({ success: false, error: m.error }, { status: m.status })
  }
  if (result?.outcome !== 'claimed') {
    return NextResponse.json({ success: false, error: CLOSED_WORDS.filled }, { status: 409 })
  }

  // The RPC only claims on a published roster, so the row is logged; the coach
  // made the change, so there is nobody to tell and it is stamped at once
  // (roster-change-format.js rule 4, self_change). Both are best-effort and
  // never throw: the claim has happened. A stamp that did not land leaves the
  // row for the re-publish safety net (a duplicate "you're on", never a loss).
  const log = await logRosterChange(db, {
    isPublished: true,
    locationId: offer.location_id,
    blockId: block.id,
    blockDate: block.block_date,
    actorId: user.id,
    coachId: user.id,
    action: 'assigned',
    details: { via: 'offer' },
  })
  if (log?.logged && log.id) await markChangesNotified(db, [log.id])

  const claimed = {
    ...offer,
    status: 'claimed',
    claimed_by: user.id,
    claimed_at: new Date(nowMs).toISOString(),
    taken_notified_at: null,
    notice_attempts: 0,
    notice_lease_until: null,
    claimer: { full_name: user.full_name ?? null },
  }
  after(() => processOffer(db, claimed, { nowMs })
    .catch((err) => logError('shift-offer', 'taken notice failed; the */5 arm retries it', { offerId: offer.id, err: err?.message })))

  return NextResponse.json({ success: true, data: { assignment_id: result.assignment_id ?? null, block_date: block.block_date } })
}
