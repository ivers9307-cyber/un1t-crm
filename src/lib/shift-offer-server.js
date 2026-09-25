// src/lib/shift-offer-server.js
//
// REPLACE.1b — the DB half of "Offer to team". Decisions are in
// ./shift-offer-notice.js and shared/offer-to-team.js; WHO is CANDIDATES.1's
// loadBlockCandidates. This file reads, sends and writes. Service-role
// client: callers (routes) have authorised the studio; the */5 arm fans out
// across studios by design.
//
// THE SENDER (processOffer) is the ONE path for both the route's after() and
// the arm, so there is no route-vs-cron race beyond the lease:
//   1. lease: a guarded UPDATE (id + the status read + the attempts read +
//      the lease free or expired) sets notice_lease_until = now + 10 min and
//      notice_attempts + 1; zero rows = someone else holds it ('busy');
//   2. recipients: CANDIDATES.1's ready + advisory minus the poster
//      (broadcast) or the studio's managers minus the claimant (taken); an
//      unreadable or unchecked answer RELEASES the lease ('retry');
//   3. send: notifyUsersOnce under shift_offer_<kind>:<id>:a<attempt>; a send
//      that failed outright releases the lease ('retry');
//   4. stamp, guarded on the status and the attempt. A process killed between
//      3 and 4 leaves an expired lease: the next attempt uses a NEW key and
//      sends again. A duplicate, never a loss (CLAUDE.md invariant (c)). A
//      stamp that fails is 'stamp_failed': logged, and counted by the arm as
//      a fault of its own (the replace arm's stamp_failed posture).
// The status guard on every notice write keeps two phases apart: a claim
// resets notice_attempts to 0 for the "taken" phase, so without it a broadcast
// still in flight at attempt 1 could stamp (and unlease) the taken attempt 1.

import { notifyUsersOnce } from './push-dedup'
import { resolveRoleRecipientIds } from './push'
import { loadBlockCandidates } from './candidates-data'
import { MANAGER_ROLES } from './schemas'
import { logError, logWarn } from './log'
import {
  offerAudienceFrom, offerSweepAction, offerBroadcastPayload, offerTakenPayload, offerNoticeKey, offerBlock,
  OFFER_NOTICE_LEASE_MS, OFFER_TAKEN_MAX_AGE_MS,
} from './shift-offer-notice'

// Literal selects: check:select-columns resolves only literals. shift_offers has
// two FKs to profiles (offered_by, claimed_by), so the embed names its column.
// The block embed is what loadBlockCandidates reads (template times = the
// window fallback) plus what the sweep and the rows read.
export const OFFER_SELECT = `
  id, location_id, block_id, status, offered_by, created_at, closed_at, claimed_by, claimed_at,
  broadcast_at, broadcast_count, broadcast_outcome, taken_notified_at, notice_lease_until, notice_attempts,
  shift_blocks!block_id(id, location_id, block_date, start_time, end_time, min_coaches, max_coaches, rosters:roster_id(status), shift_templates(name, kind, start_time, end_time), shift_assignments(profile_id, status)),
  locations(name, timezone),
  claimer:profiles!claimed_by(full_name)
`
const BLOCK_SELECT = 'id, location_id, block_date, start_time, end_time, min_coaches, max_coaches, rosters:roster_id(status), shift_templates(name, kind, start_time, end_time), shift_assignments(profile_id, status), locations(name, timezone)'
// Open offers are single digits. A guard, not a page size: a read that FILLS
// it is reported (capped) and counted as the arm's own fault.
export const SWEEP_LIMIT = 200

const iso = (ms) => new Date(ms).toISOString()
const delivered = (r) => ((r?.sent || 0) + (r?.emailed || 0)) > 0

/** One offer with its shift and studio, or null. */
export async function readOffer(db, offerId) {
  const { data, error } = await db.from('shift_offers').select(OFFER_SELECT).eq('id', offerId).maybeSingle()
  return { offer: data || null, error: error || null }
}

/** A shift as POST /blocks/[id]/offer needs it, or null. */
export async function readOfferBlock(db, blockId) {
  const { data, error } = await db.from('shift_blocks').select(BLOCK_SELECT).eq('id', blockId).maybeSingle()
  return { block: data || null, error: error || null }
}

/** Open offers at one studio (the location filter IS the tenant boundary). */
export async function listOpenOffers(db, { locationId }) {
  const { data, error } = await db.from('shift_offers')
    .select(OFFER_SELECT)
    .eq('location_id', locationId)
    .eq('status', 'open')
    .order('created_at', { ascending: true })
    .limit(SWEEP_LIMIT)
  return { offers: data || [], error: error || null }
}

/** Insert an open offer. 23505 = the shift already has one (the partial unique index). */
export async function createOffer(db, { block, actorId }) {
  const { data, error } = await db.from('shift_offers')
    .insert({ location_id: block.location_id, block_id: block.id, offered_by: actorId })
    .select(OFFER_SELECT)
    .single()
  if (error?.code === '23505') return { code: 'already_offered' }
  if (error) return { error }
  return { offer: data }
}

/** Withdraw an OPEN offer. closed:false = it was no longer open. */
export async function withdrawOffer(db, { offerId, nowIso }) {
  const { data, error } = await db.from('shift_offers')
    .update({ status: 'withdrawn', closed_at: nowIso, notice_lease_until: null })
    .eq('id', offerId)
    .eq('status', 'open')
    .select('id')
  if (error) return { error }
  return { closed: (data || []).length > 0 }
}

/** The one claim decision (mig 641). */
export async function claimOffer(db, { offerId, profileId }) {
  const { data, error } = await db.rpc('claim_shift_offer', { p_offer_id: offerId, p_profile_id: profileId })
  return { result: data || null, error: error || null }
}

async function closeOffer(db, offer, status, nowMs) {
  const { data, error } = await db.from('shift_offers')
    .update({ status, closed_at: iso(nowMs), notice_lease_until: null })
    .eq('id', offer.id)
    .eq('status', 'open')
    .select('id')
  if (error) throw new Error(error.message)
  return (data || []).length > 0
}

async function releaseLease(db, offer, attempt) {
  const { error } = await db.from('shift_offers')
    .update({ notice_lease_until: null })
    .eq('id', offer.id)
    .eq('status', offer.status)
    .eq('notice_attempts', attempt)
    .select('id')
  // Not fatal: the lease expires on its own in OFFER_NOTICE_LEASE_MS.
  if (error) logWarn('shift-offer', 'lease release failed; it expires on its own', { offerId: offer.id, err: error.message })
}

async function giveUp(db, offer, kind, nowMs) {
  const patch = kind === 'broadcast'
    ? { broadcast_at: iso(nowMs), broadcast_outcome: 'gave_up', notice_lease_until: null }
    : { taken_notified_at: iso(nowMs), notice_lease_until: null }
  const { error } = await db.from('shift_offers')
    .update(patch)
    .eq('id', offer.id)
    .eq('status', offer.status)
    .is(kind === 'broadcast' ? 'broadcast_at' : 'taken_notified_at', null)
    .select('id')
  logError('shift-offer', `gave up sending the ${kind} notice for an offer`, { offerId: offer.id, attempts: offer.notice_attempts, err: error?.message })
  // A failed give-up write is retried next tick (the offer still reads as owed).
  if (error) throw new Error(error.message)
}

async function deliver(db, offer, kind, nowMs) {
  const attempt = (offer.notice_attempts || 0) + 1
  const { data: leased, error: leaseErr } = await db.from('shift_offers')
    .update({ notice_lease_until: iso(nowMs + OFFER_NOTICE_LEASE_MS), notice_attempts: attempt })
    .eq('id', offer.id)
    .eq('status', offer.status)
    .eq('notice_attempts', offer.notice_attempts || 0)
    .or(`notice_lease_until.is.null,notice_lease_until.lt.${iso(nowMs)}`)
    .select('id')
  if (leaseErr) throw new Error(leaseErr.message)
  if (!leased || leased.length === 0) return 'busy'

  const block = offer.shift_blocks
  let ids
  if (kind === 'broadcast') {
    const answer = await loadBlockCandidates(db, { block: offerBlock(offer), audience: 'manager' })
    const audience = offerAudienceFrom(answer, offer.offered_by)
    if (audience.retry) {
      logWarn('shift-offer', 'offer audience unreadable; nobody told yet, retried next tick', { offerId: offer.id, why: audience.retry, err: answer?.error?.message })
      await releaseLease(db, offer, attempt)
      return 'retry'
    }
    ids = audience.ids
  } else {
    ids = (await resolveRoleRecipientIds(db, offer.location_id, MANAGER_ROLES)).filter((id) => id && id !== offer.claimed_by)
  }

  if (ids.length > 0) {
    const payload = kind === 'broadcast'
      ? offerBroadcastPayload({ offer, block, studioName: offer.locations?.name })
      : offerTakenPayload({ offer, block, claimerName: offer.claimer?.full_name })
    const result = await notifyUsersOnce(db, offerNoticeKey(kind, offer.id, attempt), ids, payload)
    if (!delivered(result) && (result?.failed || 0) > 0) {
      await releaseLease(db, offer, attempt)
      return 'retry'
    }
  }

  const patch = kind === 'broadcast'
    ? { broadcast_at: iso(nowMs), broadcast_count: ids.length, broadcast_outcome: ids.length ? 'sent' : 'no_recipients', notice_lease_until: null }
    : { taken_notified_at: iso(nowMs), notice_lease_until: null }
  const { data: stamped, error: stampErr } = await db.from('shift_offers')
    .update(patch)
    .eq('id', offer.id)
    .eq('status', offer.status)
    .eq('notice_attempts', attempt)
    .select('id')
  if (stampErr) {
    logError('shift-offer', 'offer notice sent but the stamp failed; the lease expires and the next attempt re-sends (a duplicate, never a loss)', { offerId: offer.id, kind, err: stampErr.message })
    return 'stamp_failed'
  }
  if (!stamped || stamped.length === 0) {
    // The offer moved on while we sent (claimed, withdrawn, closed): nothing is
    // owed for this phase any more, and a new phase has its own attempts.
    logWarn('shift-offer', 'offer notice sent; the offer changed before the stamp', { offerId: offer.id, kind })
  }
  return 'sent'
}

/**
 * Do what one offer needs right now (offerSweepAction). Returns an outcome:
 * none | quiet_hours | leased | expired | filled | raced | busy | retry | sent
 * | stamp_failed | gave_up. Throws only on a failed write the caller must
 * count (the arm catches).
 */
export async function processOffer(db, offer, { nowMs = Date.now() } = {}) {
  const tz = offer?.locations?.timezone ?? null
  const step = offerSweepAction(offer, { nowMs, tz })
  if (step.action === 'none') return step.reason || 'none'
  if (step.action === 'close') return (await closeOffer(db, offer, step.status, nowMs)) ? step.status : 'raced'
  if (step.action === 'give_up') { await giveUp(db, offer, step.kind, nowMs); return 'gave_up' }
  return deliver(db, offer, step.kind, nowMs)
}

/**
 * The five-minute arm (send-push-reminders, every 5 min). Never throws. errors > 0 means the arm
 * itself failed somewhere (an unreadable or capped list, a failed lease /
 * close / give-up write); stamp_failed > 0 means a notice went out but its
 * stamp did not land (it is re-sent after the lease). Either keeps the arm's
 * heartbeat from stamping (cron-arm-health.js offerSweepArmHealthy). A
 * 'retry' (an unreadable audience, a failed send) is not an arm fault: the
 * lease is released and the next tick retries.
 */
export async function runShiftOfferSweep(db, { nowMs = Date.now() } = {}) {
  const stats = {
    open: 0, claimed_owed: 0, none: 0, quiet_hours: 0, leased: 0, expired: 0, filled: 0, raced: 0,
    busy: 0, retry: 0, sent: 0, stamp_failed: 0, gave_up: 0, capped: 0, errors: 0,
  }
  let openRes
  let owedRes
  try {
    [openRes, owedRes] = await Promise.all([
      db.from('shift_offers').select(OFFER_SELECT).eq('status', 'open').order('created_at', { ascending: true }).limit(SWEEP_LIMIT),
      db.from('shift_offers').select(OFFER_SELECT).eq('status', 'claimed').is('taken_notified_at', null)
        .gte('claimed_at', iso(nowMs - OFFER_TAKEN_MAX_AGE_MS)).order('claimed_at', { ascending: true }).limit(SWEEP_LIMIT),
    ])
  } catch (e) {
    stats.errors++
    logError('shift-offer', 'sweep reads threw', { err: e?.message })
    return stats
  }
  if (openRes.error) { stats.errors++; logError('shift-offer', 'sweep could not read open offers', { err: openRes.error.message }) }
  if (owedRes.error) { stats.errors++; logError('shift-offer', 'sweep could not read claimed offers owed a notice', { err: owedRes.error.message }) }
  const open = openRes.error ? [] : openRes.data || []
  const owed = owedRes.error ? [] : owedRes.data || []
  stats.open = open.length
  stats.claimed_owed = owed.length
  for (const [name, list] of [['open', open], ['claimed', owed]]) {
    if (list.length >= SWEEP_LIMIT) {
      stats.capped++
      stats.errors++
      logError('shift-offer', `sweep read of ${name} offers hit its ${SWEEP_LIMIT}-row guard; the rest wait`, { count: list.length })
    }
  }
  for (const offer of [...open, ...owed]) {
    try {
      const outcome = await processOffer(db, offer, { nowMs })
      stats[outcome] = (stats[outcome] || 0) + 1
    } catch (e) {
      stats.errors++
      logError('shift-offer', 'sweep failed on an offer; the next tick retries it', { offerId: offer?.id, err: e?.message })
    }
  }
  return stats
}
