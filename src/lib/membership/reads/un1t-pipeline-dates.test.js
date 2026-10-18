// HATCHPIPE.5 — the real dates behind a un1t.online board's cards.
import { describe, it, expect } from 'vitest'
import { PIPELINE_THRESHOLDS } from '@shared/pipeline-classifier'
import { un1tStageEnteredAt, un1tFunnelEnteredAt, un1tDealDates } from './un1t-pipeline-dates'

const NOW = Date.parse('2026-10-18T12:00:00.000Z')
const DAY = 86_400_000
const ago = (d) => new Date(NOW - d * DAY).toISOString()
const ahead = (d) => new Date(NOW + d * DAY).toISOString()

const ev = (over = {}) => ({
  client_created_at: ago(40),
  attended_starts: [],
  last_attended_at: null,
  joined_at: ago(40),
  membership_status: 'lead',
  converted_at: null,
  member_since: null,
  pack_customer_at: null,
  classpass_since: null,
  gympass_since: null,
  dismissed_at: null,
  membership_ended_at: null,
  ...over,
})

describe('un1tStageEnteredAt — funnel stages', () => {
  it('new_lead: the un1t.online client creation', () => {
    expect(un1tStageEnteredAt('new_lead', ev(), NOW)).toBe(ago(40))
  })

  it('new_lead: null when they have attended (a re-entry via a booking, which the creation date does not date)', () => {
    expect(un1tStageEnteredAt('new_lead', ev({ attended_starts: [ago(90)], last_attended_at: ago(90) }), NOW)).toBeNull()
    expect(un1tStageEnteredAt('new_lead', ev({ last_attended_at: ago(90) }), NOW)).toBeNull()
  })

  it('new_lead: null when joined outside the new-lead window (only a booked class holds them there)', () => {
    const old = ago(PIPELINE_THRESHOLDS.NEW_LEAD_WINDOW_DAYS + 5)
    expect(un1tStageEnteredAt('new_lead', ev({ client_created_at: old, joined_at: old }), NOW)).toBeNull()
  })

  it('first_class: the start of the FIRST attended booking', () => {
    expect(un1tStageEnteredAt('first_class', ev({ attended_starts: [ago(5)], last_attended_at: ago(5) }), NOW)).toBe(ago(5))
  })

  it('first_class: falls back to last_attended_at when no attended booking is listed (classify counts it as one)', () => {
    expect(un1tStageEnteredAt('first_class', ev({ last_attended_at: ago(7) }), NOW)).toBe(ago(7))
  })

  it('second_class: the start of the SECOND attended booking', () => {
    expect(un1tStageEnteredAt('second_class', ev({ attended_starts: [ago(9), ago(3)], last_attended_at: ago(3) }), NOW)).toBe(ago(3))
  })

  it('second_class: null with fewer than two attended bookings', () => {
    expect(un1tStageEnteredAt('second_class', ev({ attended_starts: [ago(9)], last_attended_at: ago(9) }), NOW)).toBeNull()
  })

  it('trial_done: the start of the attended booking that reached TRIAL_DONE_MIN_ATTENDED (the 3rd), not the latest', () => {
    expect(PIPELINE_THRESHOLDS.TRIAL_DONE_MIN_ATTENDED).toBe(3)
    const starts = [ago(20), ago(14), ago(10), ago(2)]
    expect(un1tStageEnteredAt('trial_done', ev({ attended_starts: starts, last_attended_at: ago(2) }), NOW)).toBe(ago(10))
  })

  it('trial_done: null with fewer than three attended bookings', () => {
    expect(un1tStageEnteredAt('trial_done', ev({ attended_starts: [ago(20), ago(14)] }), NOW)).toBeNull()
  })

  it('orders attended bookings by start time, never by the order they were given', () => {
    const shuffled = [ago(2), ago(20), ago(10), ago(14)]
    const e = ev({ attended_starts: shuffled, last_attended_at: ago(2) })
    expect(un1tStageEnteredAt('first_class', e, NOW)).toBe(ago(20))
    expect(un1tStageEnteredAt('second_class', e, NOW)).toBe(ago(14))
    expect(un1tStageEnteredAt('trial_done', e, NOW)).toBe(ago(10))
  })

  it('ignores unreadable start times', () => {
    const e = ev({ attended_starts: ['nope', null, ago(6), ago(4)] })
    expect(un1tStageEnteredAt('first_class', e, NOW)).toBe(ago(6))
    expect(un1tStageEnteredAt('second_class', e, NOW)).toBe(ago(4))
  })
})

describe('un1tStageEnteredAt — converted, member and pack', () => {
  it('converted: converted_at (the first sub_initial sale, which is what classify reads)', () => {
    expect(un1tStageEnteredAt('converted', ev({ membership_status: 'member', converted_at: ago(12), member_since: ago(12) }), NOW)).toBe(ago(12))
  })

  it('converted: null with no converted_at', () => {
    expect(un1tStageEnteredAt('converted', ev({ membership_status: 'member', member_since: ago(12) }), NOW)).toBeNull()
  })

  it('member: the earliest of the qualifying subscription start and the first sale', () => {
    expect(un1tStageEnteredAt('member', ev({ membership_status: 'member', converted_at: ago(90), member_since: ago(95) }), NOW)).toBe(ago(95))
    expect(un1tStageEnteredAt('member', ev({ membership_status: 'member', member_since: ago(70) }), NOW)).toBe(ago(70))
  })

  it('member via paid credits (credit_member): the paid pack purchase', () => {
    expect(un1tStageEnteredAt('member', ev({ membership_status: 'credit_member', pack_customer_at: ago(8) }), NOW)).toBe(ago(8))
  })

  it('member: a pack date does not date a subscription member', () => {
    expect(un1tStageEnteredAt('member', ev({ membership_status: 'member', pack_customer_at: ago(8) }), NOW)).toBeNull()
  })

  it('pack_member: the paid pack transaction', () => {
    expect(un1tStageEnteredAt('pack_member', ev({ pack_customer_at: ago(15) }), NOW)).toBe(ago(15))
    expect(un1tStageEnteredAt('pack_member', ev(), NOW)).toBeNull()
  })
})

describe('un1tStageEnteredAt — off-funnel piles', () => {
  it('classpass / gympass: the first aggregator booking', () => {
    expect(un1tStageEnteredAt('classpass', ev({ classpass_since: ago(30) }), NOW)).toBe(ago(30))
    expect(un1tStageEnteredAt('gympass', ev({ gympass_since: ago(31) }), NOW)).toBe(ago(31))
    expect(un1tStageEnteredAt('classpass', ev(), NOW)).toBeNull()
    expect(un1tStageEnteredAt('gympass', ev(), NOW)).toBeNull()
  })

  it('cold_lead: the dismissal', () => {
    expect(un1tStageEnteredAt('cold_lead', ev({ dismissed_at: ago(3) }), NOW)).toBe(ago(3))
    expect(un1tStageEnteredAt('cold_lead', ev(), NOW)).toBeNull()
  })

  it('dormant (ex_member): the membership end', () => {
    expect(un1tStageEnteredAt('dormant', ev({ membership_status: 'ex_member', membership_ended_at: ago(20) }), NOW)).toBe(ago(20))
    expect(un1tStageEnteredAt('dormant', ev({ membership_status: 'ex_member' }), NOW)).toBeNull()
  })

  it('dormant (aged out after attending): the last attendance plus the activity window', () => {
    const e = ev({ attended_starts: [ago(80)], last_attended_at: ago(80) })
    expect(un1tStageEnteredAt('dormant', e, NOW)).toBe(ago(80 - PIPELINE_THRESHOLDS.FUNNEL_ACTIVITY_DAYS))
  })

  it('dormant (never attended): joined_at plus the new-lead window', () => {
    const e = ev({ client_created_at: ago(70), joined_at: ago(70) })
    expect(un1tStageEnteredAt('dormant', e, NOW)).toBe(ago(70 - PIPELINE_THRESHOLDS.NEW_LEAD_WINDOW_DAYS))
  })

  it('an unknown slug, or no evidence at all, is null', () => {
    expect(un1tStageEnteredAt('waitlist_new_enquiry', ev(), NOW)).toBeNull()
    expect(un1tStageEnteredAt('new_lead', null, NOW)).toBeNull()
    expect(un1tStageEnteredAt('new_lead', undefined, NOW)).toBeNull()
  })
})

describe('never a future date', () => {
  it('a stage date after now is null, so the caller keeps now', () => {
    expect(un1tStageEnteredAt('first_class', ev({ attended_starts: [ahead(1)], last_attended_at: ahead(1) }), NOW)).toBeNull()
    expect(un1tStageEnteredAt('converted', ev({ converted_at: ahead(0.01) }), NOW)).toBeNull()
    expect(un1tStageEnteredAt('new_lead', ev({ client_created_at: ahead(2) }), NOW)).toBeNull()
  })

  it('exactly now is allowed', () => {
    expect(un1tStageEnteredAt('converted', ev({ converted_at: new Date(NOW).toISOString() }), NOW)).toBe(new Date(NOW).toISOString())
  })

  it('a funnel date after now is null', () => {
    expect(un1tFunnelEnteredAt(ev({ client_created_at: ahead(1) }), NOW)).toBeNull()
  })

  it('returns ISO strings whatever spelling it was given', () => {
    expect(un1tStageEnteredAt('converted', ev({ converted_at: '2026-10-01 09:30:00+00' }), NOW)).toBe('2026-10-01T09:30:00.000Z')
  })
})

describe('un1tFunnelEnteredAt', () => {
  it('is the client creation date', () => {
    expect(un1tFunnelEnteredAt(ev({ client_created_at: ago(33) }), NOW)).toBe(ago(33))
  })

  it('is null without one', () => {
    expect(un1tFunnelEnteredAt(ev({ client_created_at: null }), NOW)).toBeNull()
    expect(un1tFunnelEnteredAt(null, NOW)).toBeNull()
  })
})

describe('un1tDealDates', () => {
  it('pairs the funnel and stage dates', () => {
    expect(un1tDealDates('first_class', ev({ attended_starts: [ago(5)], last_attended_at: ago(5) }), NOW))
      .toEqual({ created_at: ago(40), stage_entered_at: ago(5) })
  })

  it('never lets the total be shorter than time in stage (a booking dated before the client row)', () => {
    expect(un1tDealDates('first_class', ev({ client_created_at: ago(4), attended_starts: [ago(5)] }), NOW))
      .toEqual({ created_at: ago(5), stage_entered_at: ago(5) })
  })

  it('missing stage evidence leaves stage null; the funnel date still stands', () => {
    expect(un1tDealDates('second_class', ev({ attended_starts: [ago(5)] }), NOW))
      .toEqual({ created_at: ago(40), stage_entered_at: null })
  })

  it('no evidence → both null', () => {
    expect(un1tDealDates('first_class', null, NOW)).toEqual({ created_at: null, stage_entered_at: null })
  })
})
