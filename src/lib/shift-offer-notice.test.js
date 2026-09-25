// src/lib/shift-offer-notice.test.js
// REPLACE.1b — reading CANDIDATES.1's answer three ways (the push audience,
// the coach's list, the claim), the sweep's decision for one offer, the words.
import { describe, it, expect } from 'vitest'
import {
  offerAudienceFrom, offerIsFor, offerClaimRefusal, offerChecksComplete, OFFER_TIERS,
  offerSweepAction, offerNoticeState, offerBroadcastPayload, offerTakenPayload, offerNoticeKey,
  offerClaimRpcError, coachOfferRow, managerOfferRow, offerBlock, OFFER_MAX_ATTEMPTS,
} from './shift-offer-notice'

const BLOCK = {
  id: 'b1', location_id: 'loc-1', block_date: '2026-09-29', start_time: '06:00:00', end_time: '07:00:00',
  min_coaches: 1, max_coaches: 3, rosters: { status: 'published' }, shift_templates: { name: 'Morning', kind: 'class' }, shift_assignments: [],
}
const CHECKED = { shifts: true, cross_studio: true, leave: true, availability: true }
// A loadBlockCandidates answer (manager audience, withContract off): ranked, each with its tier.
const ANSWER = {
  error: null,
  checked: CHECKED,
  candidates: [
    { profile_id: 'mgr', tier: 'ready', free: true },
    { profile_id: 'c1', tier: 'ready', free: true },
    { profile_id: 'c6', tier: 'advisory', free: true, rest_gap: { rest_minutes: 600 } },
    { profile_id: 'c4', tier: 'unavailable', free: true, unavailable: { summary: 'Tuesdays 5am–9am' } },
    { profile_id: 'c2', tier: 'blocked', free: true, on_leave: { type: 'holiday' } },
    { profile_id: 'c3', tier: 'blocked', free: false, busy: { name: 'Morning' } },
  ],
}

describe('OFFER_TIERS — default 6 is CANDIDATES.1\'s "ready or advisory"', () => {
  it('free, not on leave, not unavailable; a short rest or a long week is still offered (advisory)', () => {
    expect(OFFER_TIERS).toEqual(['ready', 'advisory'])
  })
})

describe('offerAudienceFrom (the push)', () => {
  it('ready + advisory, minus the poster; managers are coaches too', () => {
    expect(offerAudienceFrom(ANSWER, 'mgr')).toEqual({ ids: ['c1', 'c6'] })
    expect(offerAudienceFrom(ANSWER, 'nobody')).toEqual({ ids: ['mgr', 'c1', 'c6'] })
  })
  it('a candidate without a tier is judged by candidateTier', () => {
    expect(offerAudienceFrom({ ...ANSWER, candidates: [{ profile_id: 'x', free: true }, { profile_id: 'y', on_leave: { type: 'sick' } }] }, 'mgr'))
      .toEqual({ ids: ['x'] })
  })
  it('nobody is pushed on an unread fact: an error, or any of shifts / other studios / leave / availability unchecked, is a retry', () => {
    expect(offerAudienceFrom({ error: { message: 'x' } }, 'mgr')).toEqual({ retry: 'candidates_unreadable' })
    expect(offerAudienceFrom(null, 'mgr')).toEqual({ retry: 'candidates_unreadable' })
    for (const facet of ['shifts', 'cross_studio', 'leave', 'availability']) {
      expect(offerAudienceFrom({ ...ANSWER, checked: { ...CHECKED, [facet]: false } }, 'mgr')).toEqual({ retry: 'candidates_unchecked' })
    }
    // contracted hours only rank; they never decide who is told.
    expect(offerAudienceFrom({ ...ANSWER, checked: { ...CHECKED, contract: false } }, 'mgr').ids).toEqual(['c1', 'c6'])
  })
  it('an empty studio is an empty audience, not a retry', () => {
    expect(offerAudienceFrom({ error: null, checked: CHECKED, candidates: [] }, 'mgr')).toEqual({ ids: [] })
  })
})

describe('offerIsFor (the coach\'s list)', () => {
  it('true for ready/advisory, false otherwise or when absent, null when it could not tell', () => {
    expect(offerIsFor(ANSWER, 'c1')).toBe(true)
    expect(offerIsFor(ANSWER, 'c6')).toBe(true)
    expect(offerIsFor(ANSWER, 'c4')).toBe(false)
    expect(offerIsFor(ANSWER, 'c2')).toBe(false)
    expect(offerIsFor(ANSWER, 'stranger')).toBe(false)
    expect(offerIsFor({ error: { message: 'x' } }, 'c1')).toBeNull()
    expect(offerIsFor({ ...ANSWER, checked: { ...CHECKED, leave: false } }, 'c1')).toBeNull()
  })
})

describe('offerClaimRefusal (unavailability does NOT block: claiming says you are free)', () => {
  const ask = (id, over = {}) => offerClaimRefusal({ ...ANSWER, ...over }, { profileId: id, liveOnBlockIds: ['c5'] })
  it('ready, advisory and unavailable may claim', () => {
    expect(ask('c1')).toBeNull()
    expect(ask('c6')).toBeNull()
    expect(ask('c4')).toBeNull()
  })
  it('leave, a clash, already on it, not a member', () => {
    expect(ask('c2')).toEqual({ status: 409, code: 'leave', error: "You're on approved leave that day, so you can't take this shift." })
    expect(ask('c3')).toEqual({ status: 409, code: 'overlap', error: "You're already on another shift at that time." })
    expect(ask('c5')).toEqual({ status: 409, code: 'on_block', error: 'You are already on this shift.' })
    expect(ask('stranger')).toEqual({ status: 403, code: 'not_member', error: 'You are not on the staff of this studio.' })
  })
  it('never a claim on a guess: an unreadable answer, or shifts / other studios / leave unchecked, is 503', () => {
    const failed = { status: 503, code: 'check_failed', error: 'Could not check your other shifts. Try again.' }
    expect(offerClaimRefusal({ error: { message: 'x' } }, { profileId: 'c1' })).toEqual(failed)
    for (const facet of ['shifts', 'cross_studio', 'leave']) expect(ask('c1', { checked: { ...CHECKED, [facet]: false } })).toEqual(failed)
    expect(ask('c1', { checked: { ...CHECKED, availability: false } })).toBeNull()
  })
})

describe('offerChecksComplete', () => {
  it('only the facts that decide default 6', () => {
    expect(offerChecksComplete(CHECKED)).toBe(true)
    expect(offerChecksComplete({ ...CHECKED, contract: false })).toBe(true)
    expect(offerChecksComplete({ ...CHECKED, availability: false })).toBe(false)
    expect(offerChecksComplete(undefined)).toBe(true) // absent = read (loadBlockCandidates always sends it)
  })
})

// Tue 29 Sep 2026 06:00 Dublin = 05:00Z.
const TZ = 'Europe/Dublin'
const IN_BAND = Date.parse('2026-09-28T10:00:00Z')
const QUIET = Date.parse('2026-09-28T22:30:00Z')
const open = (over = {}) => ({ id: 'o1', status: 'open', broadcast_at: null, notice_attempts: 0, notice_lease_until: null, shift_blocks: BLOCK, ...over })

describe('offerSweepAction', () => {
  it('open and owed a broadcast: notify in band, wait in quiet hours', () => {
    expect(offerSweepAction(open(), { nowMs: IN_BAND, tz: TZ })).toEqual({ action: 'notify', kind: 'broadcast' })
    expect(offerSweepAction(open(), { nowMs: QUIET, tz: TZ })).toEqual({ action: 'none', reason: 'quiet_hours' })
  })
  it('closes: started = expired, left a published roster = expired, got its coach = filled (at ANY hour)', () => {
    expect(offerSweepAction(open(), { nowMs: Date.parse('2026-09-29T05:00:00Z'), tz: TZ })).toEqual({ action: 'close', status: 'expired' })
    expect(offerSweepAction(open(), { nowMs: Date.parse('2026-09-29T04:59:00Z'), tz: TZ })).toEqual({ action: 'none', reason: 'quiet_hours' })
    expect(offerSweepAction(open({ shift_blocks: { ...BLOCK, rosters: { status: 'superseded' } } }), { nowMs: QUIET, tz: TZ })).toEqual({ action: 'close', status: 'expired' })
    expect(offerSweepAction(open({ shift_blocks: { ...BLOCK, shift_assignments: [{ profile_id: 'c1', status: 'scheduled' }] } }), { nowMs: QUIET, tz: TZ })).toEqual({ action: 'close', status: 'filled' })
    expect(offerSweepAction(open({ shift_blocks: null }), { nowMs: IN_BAND, tz: TZ })).toEqual({ action: 'close', status: 'expired' })
  })
  it('a live lease waits; too many attempts gives up', () => {
    expect(offerSweepAction(open({ notice_lease_until: '2026-09-28T10:05:00Z' }), { nowMs: IN_BAND, tz: TZ })).toEqual({ action: 'none', reason: 'leased' })
    expect(offerSweepAction(open({ notice_lease_until: '2026-09-28T09:55:00Z' }), { nowMs: IN_BAND, tz: TZ }).action).toBe('notify')
    expect(offerSweepAction(open({ notice_attempts: OFFER_MAX_ATTEMPTS }), { nowMs: IN_BAND, tz: TZ })).toEqual({ action: 'give_up', kind: 'broadcast' })
  })
  it('review 5 — the last attempt still in flight (its lease live) is waited for, never a false "gave up"', () => {
    expect(offerSweepAction(open({ notice_attempts: OFFER_MAX_ATTEMPTS, notice_lease_until: '2026-09-28T10:05:00Z' }), { nowMs: IN_BAND, tz: TZ }))
      .toEqual({ action: 'none', reason: 'leased' })
    expect(offerSweepAction(open({ notice_attempts: OFFER_MAX_ATTEMPTS, notice_lease_until: '2026-09-28T09:55:00Z' }), { nowMs: IN_BAND, tz: TZ }))
      .toEqual({ action: 'give_up', kind: 'broadcast' })
  })
  it('already broadcast: nothing', () => {
    expect(offerSweepAction(open({ broadcast_at: '2026-09-28T09:00:00Z' }), { nowMs: IN_BAND, tz: TZ })).toEqual({ action: 'none' })
  })
  it('claimed and the managers not yet told: notify taken in band; past 24 h gives up', () => {
    const claimed = { id: 'o1', status: 'claimed', claimed_at: '2026-09-28T09:00:00Z', taken_notified_at: null, notice_attempts: 0, notice_lease_until: null, shift_blocks: BLOCK }
    expect(offerSweepAction(claimed, { nowMs: IN_BAND, tz: TZ })).toEqual({ action: 'notify', kind: 'taken' })
    expect(offerSweepAction(claimed, { nowMs: QUIET, tz: TZ })).toEqual({ action: 'none', reason: 'quiet_hours' })
    expect(offerSweepAction({ ...claimed, claimed_at: '2026-09-27T09:00:00Z' }, { nowMs: IN_BAND, tz: TZ })).toEqual({ action: 'give_up', kind: 'taken' })
    expect(offerSweepAction({ ...claimed, taken_notified_at: '2026-09-28T09:01:00Z' }, { nowMs: IN_BAND, tz: TZ })).toEqual({ action: 'none' })
  })
  it('the band is the STUDIO\'s clock, not the server\'s', () => {
    // 10:00Z = 06:00 in New York: quiet there, in band in Dublin.
    expect(offerSweepAction(open(), { nowMs: IN_BAND, tz: 'America/New_York' })).toEqual({ action: 'none', reason: 'quiet_hours' })
  })
  it('withdrawn / expired / filled: nothing', () => {
    for (const status of ['withdrawn', 'expired', 'filled']) expect(offerSweepAction({ status }, { nowMs: IN_BAND, tz: TZ })).toEqual({ action: 'none' })
  })
})

describe('offerNoticeState (manager view)', () => {
  it('reads the broadcast columns and the band', () => {
    expect(offerNoticeState({ broadcast_at: 'x', broadcast_count: 3, broadcast_outcome: 'sent' }, { nowMs: IN_BAND, tz: TZ })).toBe('sent')
    expect(offerNoticeState({ broadcast_at: 'x', broadcast_count: 0, broadcast_outcome: 'no_recipients' }, { nowMs: IN_BAND, tz: TZ })).toBe('nobody')
    expect(offerNoticeState({ broadcast_at: 'x', broadcast_outcome: 'gave_up' }, { nowMs: IN_BAND, tz: TZ })).toBe('failed')
    expect(offerNoticeState({ broadcast_at: null }, { nowMs: IN_BAND, tz: TZ })).toBe('sending')
    expect(offerNoticeState({ broadcast_at: null }, { nowMs: QUIET, tz: TZ })).toBe('morning')
  })
})

describe('payloads and keys', () => {
  it('the broadcast: shift, when, studio; category swap; tap opens the Dashboard', () => {
    expect(offerBroadcastPayload({ offer: { id: 'o1' }, block: BLOCK, studioName: 'Studio North' })).toEqual({
      title: 'A shift is up for grabs',
      body: 'Morning, Tue 29 Sep, 06:00 to 07:00 at Studio North. First to claim it gets it. Tap to take it.',
      category: 'swap',
      emailSubject: 'A shift is up for grabs at Studio North: Tue 29 Sep, 06:00 to 07:00',
      data: { type: 'shift_offer', offer_id: 'o1', block_date: '2026-09-29' },
    })
    expect(offerBroadcastPayload({ offer: { id: 'o1' }, block: BLOCK, studioName: null }).body)
      .toBe('Morning, Tue 29 Sep, 06:00 to 07:00. First to claim it gets it. Tap to take it.')
  })
  it('taken: who and which shift; tap opens Manage mode on that day', () => {
    expect(offerTakenPayload({ offer: { id: 'o1' }, block: BLOCK, claimerName: 'Coach B' })).toEqual({
      title: 'Offered shift taken',
      body: 'Coach B took Morning, Tue 29 Sep, 06:00 to 07:00.',
      category: 'swap',
      emailSubject: 'Coach B took the offered shift: Tue 29 Sep, 06:00 to 07:00',
      data: { type: 'shift_offer_taken', offer_id: 'o1', block_date: '2026-09-29' },
    })
    expect(offerTakenPayload({ offer: { id: 'o1' }, block: BLOCK, claimerName: null }).body).toMatch(/^A coach took/)
  })
  it('no em dash in any word a person reads', () => {
    const all = [offerBroadcastPayload({ offer: { id: 'o1' }, block: BLOCK, studioName: 'Studio North' }), offerTakenPayload({ offer: { id: 'o1' }, block: BLOCK, claimerName: 'Coach B' })]
    for (const p of all) for (const s of [p.title, p.body, p.emailSubject]) expect(s).not.toMatch(/—/)
  })
  it('the ledger key is numbered by the attempt (a crash re-sends under a NEW key)', () => {
    expect(offerNoticeKey('broadcast', 'o1', 1)).toBe('shift_offer_broadcast:o1:a1')
    expect(offerNoticeKey('taken', 'o1', 2)).toBe('shift_offer_taken:o1:a2')
  })
})

describe('offerClaimRpcError', () => {
  const e = (message, code = 'P0001') => ({ code, message })
  it('maps each prefix', () => {
    expect(offerClaimRpcError(e('offer_not_open: offer is already claimed'))).toEqual({ status: 409, error: 'Someone else has just taken this shift.' })
    expect(offerClaimRpcError(e('offer_not_open: offer is already withdrawn'))).toEqual({ status: 409, error: 'This shift is no longer on offer.' })
    expect(offerClaimRpcError(e('offer_not_found: x')).status).toBe(404)
    expect(offerClaimRpcError(e('offer_not_published: x')).status).toBe(409)
    expect(offerClaimRpcError(e('offer_not_eligible: x')).status).toBe(403)
    expect(offerClaimRpcError(e('offer_already_on: x'))).toEqual({ status: 409, error: 'You are already on this shift.' })
    expect(offerClaimRpcError(e('dup', '23505'))).toEqual({ status: 409, error: 'You are already on this shift.' })
    expect(offerClaimRpcError(e('claimant_overlap: x'))).toEqual({ status: 409, error: "You're already on another shift at that time." })
    expect(offerClaimRpcError(e('boom', 'XX000'))).toEqual({ status: 500, error: 'Could not claim the shift.' })
  })
})

describe('offerBlock', () => {
  it('the shift as loadBlockCandidates wants it: the offer\'s studio is the shift\'s', () => {
    expect(offerBlock({ location_id: 'loc-1', shift_blocks: { id: 'b1', block_date: '2026-09-29' } })).toEqual({ id: 'b1', block_date: '2026-09-29', location_id: 'loc-1' })
  })
})

describe('API rows', () => {
  const row = { id: 'o1', block_id: 'b1', location_id: 'loc-1', created_at: 'c', broadcast_at: null, broadcast_count: null, broadcast_outcome: null, shift_blocks: BLOCK, locations: { name: 'Studio North', timezone: TZ } }
  it('a coach sees when, what and where: never counts or minimums', () => {
    expect(coachOfferRow(row)).toEqual({ id: 'o1', block_id: 'b1', block_date: '2026-09-29', start_time: '06:00:00', end_time: '07:00:00', shift_name: 'Morning', studio_name: 'Studio North' })
  })
  it('a manager sees the notice state', () => {
    expect(managerOfferRow(row, { nowMs: QUIET })).toEqual({ id: 'o1', block_id: 'b1', block_date: '2026-09-29', created_at: 'c', notice_state: 'morning', broadcast_count: 0 })
  })
})
