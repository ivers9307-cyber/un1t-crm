import { describe, it, expect } from 'vitest'
import { parseOfferConfig } from './offer-config.js'
import { stagesFor, classify, offerClaimLive, requiredFields, stages } from './offer.js'

const DAY = 86_400_000
const START = Date.parse('2026-11-01T10:00:00Z')
const claim = { start: START, end: START + 14 * DAY, source: 'trial_purchase' }
const cfg = (stageList, extra = {}) => parseOfferConfig({
  entry: { type: 'tag', values: ['x'] }, stages: stageList, ...extra,
}, { boardKey: 'b' }).config
const N = { role: 'new', slug: 'b_new', name: 'New' }
const F = { role: 'first_class', slug: 'b_first_class', name: '1st' }
const C2 = { role: 'class_n', slug: 'b_class_2', name: '2nd', count: 2 }
const D7 = { role: 'checkpoint', slug: 'b_day_7', name: 'Day 7', day: 7 }
const DONE = { role: 'done', slug: 'b_done', name: 'Done' }
const CONV = { role: 'converted', slug: 'b_converted', name: 'Conv' }
const full = cfg([N, F, C2, D7, DONE, CONV])

const attended = (n) => ({
  recent_bookings: Array.from({ length: n }, (_, i) => ({ attended: true, status: 'ATTENDED', time_start: Math.floor((START + (i + 1) * 3600_000) / 1000) })),
  last_attended_at: n ? new Date(START + n * 3600_000).toISOString() : null,
})

describe('offer module', () => {
  it('stagesForRowsAndOrder', () => {
    const rows = stagesFor(full)
    expect(rows.map((r) => r.slug)).toEqual(['b_new', 'b_first_class', 'b_class_2', 'b_day_7', 'b_done', 'b_converted'])
    expect(rows.map((r) => r.display_order)).toEqual([900, 901, 902, 903, 904, 905])
    expect(rows.map((r) => r.color)).toEqual(['#3B82F6', '#10B981', '#14B8A6', '#8B5CF6', '#F59E0B', '#059669'])
    expect(rows[2]).toMatchObject({ stage_role: 'class_n', role_config: { count: 2 }, is_dormant: false })
    expect(rows[3].role_config).toEqual({ day: 7 })
    expect(rows[0].role_config).toEqual({})
    expect(stages).toEqual([])
    expect(requiredFields).toEqual(expect.arrayContaining(['lead_source', 'last_lead_source', 'last_lead_source_at', 'glofox_membership_plan', 'recent_bookings']))
  })

  it('classifyWalksStages', () => {
    expect(classify({}, START + 1000, claim, full)).toBe('b_new')
    expect(classify(attended(1), START + DAY, claim, full)).toBe('b_first_class')
    expect(classify(attended(2), START + 2 * DAY, claim, full)).toBe('b_class_2')
    expect(classify(attended(2), START + 7 * DAY, claim, full)).toBe('b_day_7')
    expect(classify(attended(2), claim.end, claim, full)).toBe('b_done')
    expect(classify({ glofox_membership_status: 'member', ...attended(2) }, claim.end + DAY, claim, full)).toBe('b_converted')
    expect(classify({ pack_customer_at: new Date(claim.end).toISOString() }, claim.end + DAY, claim, full)).toBe('b_converted')
    expect(classify({ pack_customer_at: new Date(START + DAY).toISOString() }, START + 2 * DAY, claim, full)).toBe('b_new')
    expect(() => classify({}, START, null, full)).toThrow()
  })

  it('missingRolesFallThrough', () => {
    const small = cfg([N, F])
    expect(classify(attended(3), START + 8 * DAY, claim, small)).toBe('b_first_class')
    expect(classify({}, claim.end + DAY, claim, small)).toBe('b_new')
    expect(classify({ glofox_membership_status: 'member' }, claim.end + DAY, claim, small)).toBe('b_new')
    const noFirst = cfg([N, C2])
    expect(classify(attended(1), START + DAY, claim, noFirst)).toBe('b_new')
    const two = cfg([N, D7])
    expect(classify(attended(1), START + 8 * DAY, claim, two)).toBe('b_day_7')
  })

  it('claimLiveWindows', () => {
    const c = cfg([N], { quiet_days: 10, converted_window_days: 20 })
    expect(offerClaimLive(null, {}, START, c)).toBe(false)
    expect(offerClaimLive(claim, {}, claim.end + 9 * DAY, c)).toBe(true)
    expect(offerClaimLive(claim, {}, claim.end + 11 * DAY, c)).toBe(false)
    const act = { last_attended_at: new Date(claim.end + 5 * DAY).toISOString() }
    expect(offerClaimLive(claim, act, claim.end + 14 * DAY, c)).toBe(true)
    const conv = { glofox_membership_status: 'member', converted_at: new Date(claim.end + DAY).toISOString() }
    expect(offerClaimLive(claim, conv, claim.end + 20 * DAY, c)).toBe(true)
    expect(offerClaimLive(claim, conv, claim.end + 22 * DAY, c)).toBe(false)
  })
})
