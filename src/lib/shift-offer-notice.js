// src/lib/shift-offer-notice.js
//
// REPLACE.1b — the PURE half of "Offer to team" on the server: who an offer
// goes to, what blocks a claim, what the */5 sweep does with one offer, and
// every word the pushes say. The DB half is ./shift-offer-server.js; what may
// be offered at all is shared/offer-to-team.js.
//
// WHO is not decided here. Default 6 ("studio members who are free at that
// time across the organisation's studios, not on approved leave, not
// unavailable") is CANDIDATES.1's answer for the shift
// (loadBlockCandidates, src/lib/candidates-data.js): every rosterable member
// of the studio not live on the shift, each with a tier. ready and advisory
// are "free, not on leave, not unavailable"; unavailable and blocked are not.
// This file only reads that answer, three ways:
//   - the push (offerAudienceFrom): ready + advisory minus the poster; an
//     unread fact means NOBODY is told yet (retry), never a guess;
//   - the coach's list (offerIsFor): the same tiers; null = could not tell;
//   - the claim (offerClaimRefusal): leave or a clash refuses; unavailability
//     does not (a coach claiming is telling us they are free).
// All three ask with publishedShiftsOnly (review 4, owner decision): "free"
// means no PUBLISHED overlapping shift. A coach is never skipped or refused
// over a draft they cannot see.
// Consequence, on purpose: CANDIDATES counts ANY approved leave covering the
// day (a half-day too) as blocked, so a coach on a half-day is neither pushed
// nor allowed to claim; the picker and the offer agree.
//
// WHEN: closing an offer is STATE and happens at any hour; a notice is a
// MESSAGE and waits for 07:00-22:00 studio time (src/lib/staff-push-hours.js).

import { candidateTier } from '@shared/candidates'
import { offerStillNeeded } from '@shared/offer-to-team'
import { shiftWhenLabel, swapShiftHasStarted } from './swap-cover'
import { inStaffPushHours } from './staff-push-hours'

export const OFFER_NOTICE_LEASE_MS = 10 * 60 * 1000
export const OFFER_MAX_ATTEMPTS = 5
export const OFFER_TAKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** CANDIDATES.1 tiers that are "free, not on leave, not unavailable". */
export const OFFER_TIERS = Object.freeze(['ready', 'advisory'])

// The facts that decide default 6. contract only ranks, so it never blocks.
const DECIDING_FACTS = ['shifts', 'cross_studio', 'leave', 'availability']
// The facts that decide a CLAIM (availability does not block one).
const CLAIM_FACTS = ['shifts', 'cross_studio', 'leave']

/** Were the facts that decide it all read? An absent key counts as read. */
export function offerChecksComplete(checked, facts = DECIDING_FACTS) {
  return facts.every((k) => checked?.[k] !== false)
}

const tierOf = (c) => c?.tier ?? candidateTier(c)

/**
 * The push audience, from a loadBlockCandidates answer (audience 'manager').
 * @returns {{ ids: string[] } | { retry: 'candidates_unreadable'|'candidates_unchecked' }}
 */
export function offerAudienceFrom(result, posterId) {
  if (!result || result.error) return { retry: 'candidates_unreadable' }
  if (!offerChecksComplete(result.checked)) return { retry: 'candidates_unchecked' }
  const ids = (result.candidates || [])
    .filter((c) => c?.profile_id && c.profile_id !== posterId && OFFER_TIERS.includes(tierOf(c)))
    .map((c) => c.profile_id)
  return { ids }
}

/** Is this offer for `profileId`? true / false, or null when it could not be told. */
export function offerIsFor(result, profileId) {
  if (!result || result.error || !offerChecksComplete(result.checked)) return null
  const c = (result.candidates || []).find((x) => x?.profile_id === profileId)
  return !!c && OFFER_TIERS.includes(tierOf(c))
}

/**
 * May `profileId` claim? null = yes. Never a claim on a guess: an unreadable
 * answer (or an unread deciding fact) is 503, try again.
 * @returns {null | { status: number, code: string, error: string }}
 */
export function offerClaimRefusal(result, { profileId, liveOnBlockIds = [] }) {
  if (!result || result.error || !offerChecksComplete(result.checked, CLAIM_FACTS)) {
    return { status: 503, code: 'check_failed', error: 'Could not check your other shifts. Try again.' }
  }
  const c = (result.candidates || []).find((x) => x?.profile_id === profileId)
  if (!c) {
    // loadBlockCandidates lists rosterable members NOT on the shift, so an
    // absent caller is either on it already or not a member here.
    return liveOnBlockIds.includes(profileId)
      ? { status: 409, code: 'on_block', error: 'You are already on this shift.' }
      : { status: 403, code: 'not_member', error: 'You are not on the staff of this studio.' }
  }
  if (c.on_leave) return { status: 409, code: 'leave', error: "You're on approved leave that day, so you can't take this shift." }
  if (c.free === false) return { status: 409, code: 'overlap', error: "You're already on another shift at that time." }
  return null
}

function noticeStep(offer, kind, nowMs, tz) {
  // A live lease FIRST (review 5): attempt 5 still in flight must not be
  // stamped "gave up" by the next tick while it may yet be delivered.
  const leaseMs = Date.parse(offer.notice_lease_until)
  if (Number.isFinite(leaseMs) && leaseMs > nowMs) return { action: 'none', reason: 'leased' }
  if ((offer.notice_attempts || 0) >= OFFER_MAX_ATTEMPTS) return { action: 'give_up', kind }
  if (!inStaffPushHours(nowMs, tz)) return { action: 'none', reason: 'quiet_hours' }
  return { action: 'notify', kind }
}

/**
 * What the sweep (or the route's after()) does with ONE offer right now. Pure.
 * Closing is STATE and happens at any hour; a notice is a MESSAGE and waits
 * for 07:00-22:00 studio time.
 *
 * @param {object} offer  OFFER_SELECT row (shift_blocks embed with rosters,
 *   shift_templates.kind, min/max, shift_assignments)
 * @param {{ nowMs: number, tz: string|null }} opts  tz = the studio's locations.timezone
 * @returns {{action:'none', reason?:string} | {action:'close', status:'expired'|'filled'}
 *   | {action:'notify'|'give_up', kind:'broadcast'|'taken'}}
 */
export function offerSweepAction(offer, { nowMs, tz }) {
  if (offer?.status === 'open') {
    const b = offer.shift_blocks
    if (!b) return { action: 'close', status: 'expired' }
    if (swapShiftHasStarted({ block_date: b.block_date, start_time: b.start_time }, nowMs, tz)) return { action: 'close', status: 'expired' }
    if (b.rosters?.status !== 'published') return { action: 'close', status: 'expired' }
    if (!offerStillNeeded(b)) return { action: 'close', status: 'filled' }
    if (offer.broadcast_at) return { action: 'none' }
    return noticeStep(offer, 'broadcast', nowMs, tz)
  }
  if (offer?.status === 'claimed' && !offer.taken_notified_at) {
    const claimedMs = Date.parse(offer.claimed_at)
    if (!Number.isFinite(claimedMs) || nowMs - claimedMs > OFFER_TAKEN_MAX_AGE_MS) return { action: 'give_up', kind: 'taken' }
    return noticeStep(offer, 'taken', nowMs, tz)
  }
  return { action: 'none' }
}

/** The manager view's notice state of an OPEN offer (shared/offer-to-team.js offerStateLabel words it). */
export function offerNoticeState(offer, { nowMs, tz }) {
  if (offer?.broadcast_outcome === 'gave_up') return 'failed'
  if (offer?.broadcast_at) return offer.broadcast_outcome === 'no_recipients' || !(Number(offer.broadcast_count) > 0) ? 'nobody' : 'sent'
  return inStaffPushHours(nowMs, tz) ? 'sending' : 'morning'
}

const STUDIO_NAME_MAX = 30
const shortStudio = (n) => {
  const s = String(n ?? '').trim()
  return s.length <= STUDIO_NAME_MAX ? s : `${s.slice(0, STUDIO_NAME_MAX).trimEnd()}…`
}
const whatWhen = (block) => {
  const when = shiftWhenLabel(block)
  const name = block?.shift_templates?.name
  return name ? `${name}, ${when}` : when
}

/** "A shift is up for grabs" — one per eligible coach, category swap (registered, email fallback). */
export function offerBroadcastPayload({ offer, block, studioName }) {
  const studio = shortStudio(studioName)
  const at = studio ? ` at ${studio}` : ''
  return {
    title: 'A shift is up for grabs',
    body: `${whatWhen(block)}${at}. First to claim it gets it. Tap to take it.`,
    category: 'swap',
    emailSubject: `A shift is up for grabs${at}: ${shiftWhenLabel(block)}`,
    data: { type: 'shift_offer', offer_id: offer.id, block_date: block?.block_date ?? null },
  }
}

/** "Coach B took …" — the studio's managers, category swap. */
export function offerTakenPayload({ offer, block, claimerName }) {
  const who = claimerName || 'A coach'
  return {
    title: 'Offered shift taken',
    body: `${who} took ${whatWhen(block)}.`,
    category: 'swap',
    emailSubject: `${who} took the offered shift: ${shiftWhenLabel(block)}`,
    data: { type: 'shift_offer_taken', offer_id: offer.id, block_date: block?.block_date ?? null },
  }
}

/** The shift as loadBlockCandidates wants it (the offer's studio is the shift's). */
export const offerBlock = (offer) => ({ ...offer.shift_blocks, location_id: offer.location_id })

/** push_event_sends key, numbered by attempt: a crashed attempt's claim never dedups the retry. */
export const offerNoticeKey = (kind, offerId, attempt) => `shift_offer_${kind}:${offerId}:a${attempt}`

/** claim_shift_offer error -> { status, error }. */
export function offerClaimRpcError(err) {
  if (err?.code === '23505') return { status: 409, error: 'You are already on this shift.' }
  const msg = String(err?.message || '')
  switch (msg.split(':')[0]) {
    case 'offer_not_open':
      return { status: 409, error: /claimed/.test(msg) ? 'Someone else has just taken this shift.' : 'This shift is no longer on offer.' }
    case 'offer_not_found': return { status: 404, error: 'Offer not found' }
    case 'offer_not_published': return { status: 409, error: 'This shift is no longer on offer.' }
    case 'offer_not_eligible': return { status: 403, error: 'You are not on the staff of this studio.' }
    case 'offer_already_on': return { status: 409, error: 'You are already on this shift.' }
    case 'claimant_overlap': return { status: 409, error: "You're already on another shift at that time." }
    default: return { status: 500, error: 'Could not claim the shift.' }
  }
}

/** A coach's list row: when, what, where. No counts, no minimums (COACHSCOPE.1). */
export function coachOfferRow(offer) {
  const b = offer.shift_blocks || {}
  return {
    id: offer.id,
    block_id: offer.block_id,
    block_date: b.block_date ?? null,
    start_time: b.start_time ?? null,
    end_time: b.end_time ?? null,
    shift_name: b.shift_templates?.name ?? null,
    studio_name: offer.locations?.name ?? null,
  }
}

/** A manager's list row. */
export function managerOfferRow(offer, { nowMs }) {
  return {
    id: offer.id,
    block_id: offer.block_id,
    block_date: offer.shift_blocks?.block_date ?? null,
    created_at: offer.created_at ?? null,
    notice_state: offerNoticeState(offer, { nowMs, tz: offer.locations?.timezone ?? null }),
    broadcast_count: Number(offer.broadcast_count) || 0,
  }
}
