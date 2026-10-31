// PIPE3.1 — the €39 Trial board module. Pure rules; every instant is epoch ms.
// Spec: docs/superpowers/specs/2026-10-31-stillorgan-three-pipelines-design.md
import { describe, it, expect } from 'vitest'
import {
  stages, requiredFields, paidTrialClaim, claimLive, classify, attendedSince, convertedSince, lastActivityMs, DAY_MS,
} from './paid-trial.js'

const T0 = Date.parse('2026-10-24T08:19:21Z')
const iso = (ms) => new Date(ms).toISOString()
const granted = (over = {}) => ({ status: 'granted', payment_status: 'paid', paid_at: iso(T0 - 3_600_000), granted_at: iso(T0), duration_days: 14, ...over })
const booking = (ms) => ({ status: 'BOOKED', attended: true, time_start: Math.floor(ms / 1000) })

describe('stages', () => {
  it('five on-funnel columns in order', () => {
    expect(stages.map((s) => s.slug)).toEqual(['paid_trial_new_lead', 'paid_trial_first_class', 'paid_trial_day_7', 'paid_trial_done', 'paid_trial_converted'])
    expect(stages.map((s) => s.name)).toEqual(['New Leads', '1st Class', 'Day 7', 'Trial Done', 'Converted'])
    expect(stages.every((s) => s.is_dormant === false)).toBe(true)
    expect(stages.map((s) => s.display_order)).toEqual([601, 602, 603, 604, 605])
    expect(stages.every((s) => /^#[0-9A-F]{6}$/.test(s.color))).toBe(true)
  })
  it('declares the acquisition classifier inputs', () => {
    for (const f of ['id', 'glofox_membership_status', 'recent_bookings', 'converted_at', 'pack_customer_at', 'last_payment_at', 'last_attended_at', 'pipeline_dismissed_at', 'last_lead_source_at', 'gympass_member_id', 'joined_at']) {
      expect(requiredFields, `missing ${f}`).toContain(f)
    }
  })
})

describe('paidTrialClaim', () => {
  it('a granted row: start is granted_at, end is +duration', () => {
    expect(paidTrialClaim([granted()], T0)).toMatchObject({ start: T0, end: T0 + 14 * DAY_MS, durationDays: 14, grantedAt: T0, paidAt: T0 - 3_600_000 })
  })
  it('paid but not granted yet (needs_review): start is paid_at', () => {
    const c = paidTrialClaim([granted({ status: 'needs_review', granted_at: null })], T0)
    expect(c.start).toBe(T0 - 3_600_000)
    expect(c.grantedAt).toBeNull()
  })
  it('a missing duration_days means 14', () => {
    expect(paidTrialClaim([granted({ duration_days: null })], T0).end).toBe(T0 + 14 * DAY_MS)
  })
  it('awaiting_payment, payment_failed and failed rows are not claims', () => {
    expect(paidTrialClaim([granted({ status: 'awaiting_payment', payment_status: null, paid_at: null, granted_at: null })], T0)).toBeNull()
    expect(paidTrialClaim([granted({ status: 'payment_failed', payment_status: 'failed' })], T0)).toBeNull()
    expect(paidTrialClaim([granted({ status: 'failed' })], T0)).toBeNull()
    expect(paidTrialClaim([granted({ status: 'queued', payment_status: null })], T0)).toBeNull()
    expect(paidTrialClaim([], T0)).toBeNull()
    expect(paidTrialClaim(null, T0)).toBeNull()
  })
  it('the newest start wins when there are several', () => {
    const c = paidTrialClaim([granted(), granted({ granted_at: iso(T0 + 40 * DAY_MS) })], T0 + 41 * DAY_MS)
    expect(c.start).toBe(T0 + 40 * DAY_MS)
  })
})

describe('classify', () => {
  const claim = paidTrialClaim([granted()], T0)
  it('day 0, nothing attended: new lead', () => {
    expect(classify({ glofox_membership_status: 'trial' }, T0 + DAY_MS, claim)).toBe('paid_trial_new_lead')
  })
  it('one class since the grant: 1st Class', () => {
    expect(classify({ glofox_membership_status: 'trial', recent_bookings: [booking(T0 + DAY_MS)], last_attended_at: iso(T0 + DAY_MS) }, T0 + 2 * DAY_MS, claim)).toBe('paid_trial_first_class')
  })
  it('a class BEFORE the grant does not count', () => {
    expect(classify({ glofox_membership_status: 'trial', recent_bookings: [booking(T0 - 5 * DAY_MS)], last_attended_at: iso(T0 - 5 * DAY_MS) }, T0 + DAY_MS, claim)).toBe('paid_trial_new_lead')
  })
  it('exactly 7 × 24h in is Day 7, trained or not', () => {
    expect(classify({ glofox_membership_status: 'trial' }, T0 + 7 * DAY_MS, claim)).toBe('paid_trial_day_7')
    expect(classify({ glofox_membership_status: 'trial', last_attended_at: iso(T0 + DAY_MS) }, T0 + 9 * DAY_MS, claim)).toBe('paid_trial_day_7')
    expect(classify({ glofox_membership_status: 'trial' }, T0 + 7 * DAY_MS - 1, claim)).toBe('paid_trial_new_lead')
  })
  it('exactly duration × 24h in is Trial Done', () => {
    expect(classify({ glofox_membership_status: 'trial' }, T0 + 14 * DAY_MS, claim)).toBe('paid_trial_done')
    expect(classify({ glofox_membership_status: 'trial' }, T0 + 14 * DAY_MS - 1, claim)).toBe('paid_trial_day_7')
  })
  it('a member status is Converted at any point, converted_at or not', () => {
    expect(classify({ glofox_membership_status: 'member', converted_at: iso(T0 + 3 * DAY_MS) }, T0 + 4 * DAY_MS, claim)).toBe('paid_trial_converted')
    expect(classify({ glofox_membership_status: 'credit_member', converted_at: null }, T0 + 20 * DAY_MS, claim)).toBe('paid_trial_converted')
  })
  it('a Class Pack stamped after the trial ENDED is Converted; a stamp inside the window is the trial\'s own credits', () => {
    expect(classify({ glofox_membership_status: 'trial', pack_customer_at: iso(T0 + 16 * DAY_MS) }, T0 + 17 * DAY_MS, claim)).toBe('paid_trial_converted')
    expect(classify({ glofox_membership_status: 'trial', pack_customer_at: iso(T0 + 14 * DAY_MS) }, T0 + 15 * DAY_MS, claim)).toBe('paid_trial_converted')
    // The real buyer on 2026-10-30: stamped 4 minutes after the grant, 10 credits.
    expect(classify({ glofox_membership_status: 'trial', trial_credits_remaining: 10, pack_customer_at: iso(T0 + 4 * 60_000) }, T0 + DAY_MS, claim)).toBe('paid_trial_new_lead')
    expect(classify({ glofox_membership_status: 'trial', trial_credits_remaining: 10, pack_customer_at: iso(T0 + 4 * 60_000) }, T0 + 14 * DAY_MS, claim)).toBe('paid_trial_done')
    expect(classify({ glofox_membership_status: 'trial', trial_credits_remaining: 10, pack_customer_at: iso(T0 - DAY_MS) }, T0 + DAY_MS, claim)).toBe('paid_trial_new_lead')
  })
  it('throws without a claim', () => {
    expect(() => classify({}, T0, null)).toThrow(TypeError)
  })
})

describe('claimLive', () => {
  const claim = paidTrialClaim([granted()], T0)
  it('live through the trial and for 60 quiet days after it ends', () => {
    expect(claimLive(claim, { glofox_membership_status: 'trial' }, T0 + DAY_MS)).toBe(true)
    expect(claimLive(claim, { glofox_membership_status: 'trial' }, T0 + 14 * DAY_MS + 60 * DAY_MS - 1)).toBe(true)
    expect(claimLive(claim, { glofox_membership_status: 'trial' }, T0 + 14 * DAY_MS + 60 * DAY_MS)).toBe(false)
  })
  it('a class or payment after the end restarts the quiet clock', () => {
    const c = { glofox_membership_status: 'trial', last_attended_at: iso(T0 + 30 * DAY_MS) }
    expect(claimLive(claim, c, T0 + 30 * DAY_MS + 60 * DAY_MS - 1)).toBe(true)
    expect(claimLive(claim, c, T0 + 30 * DAY_MS + 60 * DAY_MS)).toBe(false)
    const p = { glofox_membership_status: 'trial', last_payment_at: iso(T0 + 40 * DAY_MS) }
    expect(claimLive(claim, p, T0 + 40 * DAY_MS + 60 * DAY_MS - 1)).toBe(true)
  })
  it('converted: live for 60 days from converted_at, then not', () => {
    const c = { glofox_membership_status: 'member', converted_at: iso(T0 + 5 * DAY_MS) }
    expect(claimLive(claim, c, T0 + 5 * DAY_MS + 60 * DAY_MS - 1)).toBe(true)
    expect(claimLive(claim, c, T0 + 5 * DAY_MS + 60 * DAY_MS)).toBe(false)
  })
  it('converted with no converted_at: 60 days from the last activity', () => {
    const c = { glofox_membership_status: 'member', converted_at: null, last_payment_at: iso(T0 + 10 * DAY_MS) }
    expect(claimLive(claim, c, T0 + 10 * DAY_MS + 60 * DAY_MS - 1)).toBe(true)
    expect(claimLive(claim, c, T0 + 10 * DAY_MS + 60 * DAY_MS)).toBe(false)
  })
  it('null claim is never live', () => { expect(claimLive(null, {}, T0)).toBe(false) })
})

describe('helpers', () => {
  it('attendedSince counts bookings at/after the instant and floors on last_attended_at', () => {
    expect(attendedSince({ recent_bookings: [booking(T0 + 1000), booking(T0 - 1000)] }, T0)).toBe(1)
    expect(attendedSince({ recent_bookings: [], last_attended_at: iso(T0 + 1) }, T0)).toBe(1)
    expect(attendedSince({ recent_bookings: [booking(T0 + 1000), booking(T0 + 2000)], last_attended_at: iso(T0 + 2000) }, T0)).toBe(2)
    expect(attendedSince({}, T0)).toBe(0)
    expect(attendedSince(null, T0)).toBe(0)
  })
  it('convertedSince: member status, or a pack stamp at/after the pack instant', () => {
    expect(convertedSince({ glofox_membership_status: 'member' }, T0)).toBe(true)
    expect(convertedSince({ glofox_membership_status: 'credit_member' }, T0)).toBe(true)
    expect(convertedSince({ pack_customer_at: iso(T0) }, T0)).toBe(true)
    expect(convertedSince({ pack_customer_at: iso(T0 - 1) }, T0)).toBe(false)
    expect(convertedSince({ glofox_membership_status: 'trial' }, T0)).toBe(false)
  })
  it('lastActivityMs is the later of last_attended_at and last_payment_at, or null', () => {
    expect(lastActivityMs({ last_attended_at: iso(T0), last_payment_at: iso(T0 + 1000) })).toBe(T0 + 1000)
    expect(lastActivityMs({ last_attended_at: iso(T0) })).toBe(T0)
    expect(lastActivityMs({ last_attended_at: 'nonsense' })).toBeNull()
    expect(lastActivityMs({})).toBeNull()
  })
})
