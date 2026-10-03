// shared/offer-to-team.test.js
// REPLACE.1b — the ONE rule the web button, the phone button and
// POST /api/schedule/blocks/[id]/offer ask: may this shift be offered?
import { describe, it, expect } from 'vitest'
import {
  offerTargetCount, offerStillNeeded, offerRefusal, OFFER_REFUSALS,
  offerStateLabel, offerWhenLine, indexOffersByBlock, offerPostResultText, offerClaimResultText,
} from './offer-to-team.js'

const TODAY = '2026-09-28'
const live = (n) => Array.from({ length: n }, (_, i) => ({ profile_id: `p${i}`, status: 'scheduled' }))
const cls = (over = {}) => ({ block_date: '2026-09-29', min_coaches: 2, max_coaches: 3, rosters: { status: 'published' }, shift_templates: { kind: 'class' }, shift_assignments: [], ...over })
const admin = (over = {}) => cls({ min_coaches: 0, shift_templates: { kind: 'admin' }, ...over })

describe('offerTargetCount', () => {
  it('a class shift wants its minimum (at least 1); an admin shift, 1', () => {
    expect(offerTargetCount(cls())).toBe(2)
    expect(offerTargetCount(cls({ min_coaches: 0 }))).toBe(1)
    expect(offerTargetCount(admin())).toBe(1)
    expect(offerTargetCount(admin({ min_coaches: 3 }))).toBe(1)
    expect(offerTargetCount({ min_coaches: 3 })).toBe(3) // unreadable kind = class (shared/shift-kind.js)
    expect(offerTargetCount(null)).toBe(1)
  })
})

describe('offerStillNeeded', () => {
  it('class: needed while live coaches are below the minimum; cancelled rows are not coaches', () => {
    expect(offerStillNeeded(cls())).toBe(true)
    expect(offerStillNeeded(cls({ shift_assignments: live(1) }))).toBe(true)
    expect(offerStillNeeded(cls({ shift_assignments: live(2) }))).toBe(false)
    expect(offerStillNeeded(cls({ shift_assignments: [...live(1), { profile_id: 'x', status: 'cancelled' }] }))).toBe(true)
  })
  it('admin: needed only while EMPTY (no minimum, so never "short")', () => {
    expect(offerStillNeeded(admin())).toBe(true)
    expect(offerStillNeeded(admin({ shift_assignments: live(1) }))).toBe(false)
  })
  it('never past max_coaches', () => {
    expect(offerStillNeeded(cls({ min_coaches: 3, max_coaches: 2, shift_assignments: live(2) }))).toBe(false)
  })
})

describe('offerRefusal', () => {
  it('an empty or short published future class shift, or an empty admin one, may be offered', () => {
    expect(offerRefusal(cls(), { todayIso: TODAY })).toBeNull()
    expect(offerRefusal(cls({ shift_assignments: live(1) }), { todayIso: TODAY })).toBeNull()
    expect(offerRefusal(admin(), { todayIso: TODAY })).toBeNull()
    expect(offerRefusal(cls({ block_date: TODAY }), { todayIso: TODAY })).toBeNull()
  })
  it('refuses in order: draft, past, started, already offered, staffed', () => {
    expect(offerRefusal(cls({ rosters: { status: 'draft' } }), { todayIso: TODAY })).toBe('not_published')
    expect(offerRefusal(cls({ rosters: null }), { todayIso: TODAY })).toBe('not_published')
    expect(offerRefusal(cls({ block_date: '2026-09-27' }), { todayIso: TODAY })).toBe('past')
    expect(offerRefusal(cls(), { todayIso: TODAY, started: true })).toBe('started')
    expect(offerRefusal(cls(), { todayIso: TODAY, hasOpenOffer: true })).toBe('already_offered')
    expect(offerRefusal(cls({ shift_assignments: live(2) }), { todayIso: TODAY })).toBe('staffed')
    expect(offerRefusal(admin({ shift_assignments: live(1) }), { todayIso: TODAY })).toBe('staffed')
    expect(offerRefusal(null, { todayIso: TODAY })).toBe('unknown')
  })
  it('every refusal has words', () => {
    for (const key of ['not_published', 'past', 'started', 'already_offered', 'staffed', 'unknown']) expect(OFFER_REFUSALS[key]).toMatch(/\w/)
  })
})

describe('offerStateLabel (the manager\'s line)', () => {
  it('says whether and how the team was told', () => {
    expect(offerStateLabel({ notice_state: 'sent', broadcast_count: 4 })).toBe('Offered to 4 coaches')
    expect(offerStateLabel({ notice_state: 'sent', broadcast_count: 1 })).toBe('Offered to 1 coach')
    expect(offerStateLabel({ notice_state: 'nobody', broadcast_count: 0 })).toBe('Offered to the team · nobody is free to ask')
    expect(offerStateLabel({ notice_state: 'sending' })).toBe('Offered to the team · telling coaches now')
    expect(offerStateLabel({ notice_state: 'morning' })).toBe('Offered to the team · coaches are told from 7am')
    expect(offerStateLabel({ notice_state: 'failed' })).toBe("Offered to the team · the notification couldn't be sent")
    expect(offerStateLabel({})).toBe('Offered to the team')
  })
})

describe('offerWhenLine (the coach\'s card)', () => {
  it('weekday, date and times, from the date\'s own parts (no timezone moves it)', () => {
    expect(offerWhenLine({ block_date: '2026-09-29', start_time: '06:00:00', end_time: '07:00:00' })).toBe('Tue 29 Sep · 06:00-07:00')
    expect(offerWhenLine({ block_date: '2026-03-29', start_time: '06:00:00', end_time: '07:00:00' })).toBe('Sun 29 Mar · 06:00-07:00') // DST day
    expect(offerWhenLine({ block_date: '2026-02-30', start_time: '06:00:00', end_time: '07:00:00' })).toBe('06:00-07:00')
    expect(offerWhenLine({})).toBe('')
  })
})

describe('indexOffersByBlock', () => {
  it('open offers keyed by shift; junk dropped', () => {
    expect(indexOffersByBlock([{ id: 'o1', block_id: 'b1' }, null, { id: 'o2' }])).toEqual({ b1: { id: 'o1', block_id: 'b1' } })
    expect(indexOffersByBlock(null)).toEqual({})
  })
})

describe('result words (web toast and phone alert)', () => {
  it('posting', () => {
    expect(offerPostResultText(201, { success: true, data: { notice: 'now' } })).toEqual({ tone: 'success', text: 'Offered to the team. Coaches who are free are being told now.' })
    expect(offerPostResultText(201, { success: true, data: { notice: 'morning' } })).toEqual({ tone: 'warning', text: 'Offered to the team. Coaches see it on Today now and get a notification from 7am.' })
    expect(offerPostResultText(409, { success: false, error: 'This shift is already offered to the team.' })).toEqual({ tone: 'error', text: 'This shift is already offered to the team.' })
    expect(offerPostResultText(0, null)).toEqual({ tone: 'error', text: 'Could not offer the shift.' })
  })
  it('claiming', () => {
    expect(offerClaimResultText(200, { success: true })).toEqual({ tone: 'success', text: "It's yours. It is on your roster now." })
    expect(offerClaimResultText(409, { success: false, error: 'Someone else has just taken this shift.' })).toEqual({ tone: 'error', text: 'Someone else has just taken this shift.' })
    expect(offerClaimResultText(0, null)).toEqual({ tone: 'error', text: 'Could not claim the shift.' })
  })
})
