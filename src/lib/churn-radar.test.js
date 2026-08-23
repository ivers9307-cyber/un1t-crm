// Tests for churn-radar.js — pure scoring, deterministic against a
// fixed "now".

import { describe, it, expect } from 'vitest'
import {
  classifyContact,
  hasLiveMembership,
  isRealMembershipPlan,
  bucketArrears,
  scoreMember,
  buildRadar,
  radarSummary,
  buildOverdue,
  paymentTroubleKind,
  classifyRefreshedMember,
  monthlyValueCents,
  scoreWinbackContact,
  buildWinback,
  computeRecoveryStats,
  computeTrend,
  MEMBER_STATUSES,
} from './churn-radar.js'

const NOW = Date.parse('2026-05-21T12:00:00.000Z')
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString()
const daysAhead = (n) => new Date(NOW + n * 86_400_000).toISOString()

// A healthy active member — a live subscription, paying, attended
// yesterday, regular.
function healthy(over = {}) {
  return {
    id: 'c-healthy',
    name: 'Healthy Member',
    glofox_membership_status: 'member',
    glofox_membership_type: 'time',
    glofox_membership_state: 'active',
    last_attended_at: daysAgo(1),
    last_booked_at: daysAgo(1),
    total_attended_30d: 10,
    total_attended_7d: 3,
    total_noshow_30d: 0,
    total_bookings_30d: 10,
    ...over,
  }
}

// A live class-pack member — credits remaining, segments as 'credit'.
function pack(over = {}) {
  return healthy({
    id: 'c-pack',
    name: 'Pack Member',
    glofox_membership_status: 'credit_member',
    glofox_membership_type: 'num_classes',
    glofox_membership_state: null,
    trial_credits_remaining: 5,
    ...over,
  })
}

describe('classifyContact', () => {
  it('marks non-members as out of scope', () => {
    expect(classifyContact({ glofox_membership_status: 'trial' })).toBe('out')
    expect(classifyContact({ glofox_membership_status: 'lead' })).toBe('out')
    expect(classifyContact(null)).toBe('out')
  })
  it('marks a live member with an activity footprint as active', () => {
    expect(classifyContact(healthy())).toBe('active')
    expect(classifyContact(healthy({ last_attended_at: null }))).toBe('active') // last_booked_at still set
    expect(classifyContact(pack())).toBe('active')
  })
  it('marks a live member with no footprint as quarantine', () => {
    expect(classifyContact(healthy({ last_attended_at: null, last_booked_at: null }))).toBe('quarantine')
    expect(classifyContact(pack({ last_attended_at: null, last_booked_at: null }))).toBe('quarantine')
  })
  it('marks a contact with an open PAST_DUE invoice as overdue (RADAR-OVERDUE.1)', () => {
    const ctx = { pastDueIds: new Set(['c-healthy']) }
    expect(classifyContact(healthy(), ctx)).toBe('overdue')
    // overdue (a real debt) is decided before the footprint + live-membership gates
    expect(classifyContact(healthy({ last_attended_at: null, last_booked_at: null }), ctx)).toBe('overdue')
  })
  it('no longer treats a stale membership_state=locked (no past-due invoice) as overdue (RADAR-OVERDUE.1)', () => {
    // The audit smoking gun: locked is the unreliable singular-membership
    // field. With no past-due invoice the member is just active.
    expect(classifyContact(healthy({ glofox_membership_state: 'locked' }))).toBe('active')
  })
})

describe('hasLiveMembership', () => {
  it('treats a credit_member class pack as live only while credits remain', () => {
    const ck = (over) => hasLiveMembership({ glofox_membership_status: 'credit_member', glofox_membership_type: 'num_classes', ...over })
    expect(ck({ trial_credits_remaining: 3 })).toBe(true)
    expect(ck({ trial_credits_remaining: 0 })).toBe(false)
    expect(ck({ trial_credits_remaining: null })).toBe(false)
    expect(ck({})).toBe(false)
  })
  it('rejects a member+num_classes row — the stale trial-pack reference, not a real pack (CHURN-CLEAN.1)', () => {
    // Glofox's member.membership is typically the initial trial pack;
    // a real class pack is detected as credit_member (Plan A). A
    // 'member' + num_classes with credits is NOT a current pack.
    expect(hasLiveMembership({ glofox_membership_status: 'member', glofox_membership_type: 'num_classes', trial_credits_remaining: 5 })).toBe(false)
  })
  it('rejects a trial / open-week / one-off plan by name whatever the type (CHURN-CLEAN.1)', () => {
    expect(hasLiveMembership({ glofox_membership_status: 'credit_member', glofox_membership_type: 'num_classes', trial_credits_remaining: 5, glofox_membership_plan: 'The UN1T Trial' })).toBe(false)
    expect(hasLiveMembership({ glofox_membership_status: 'credit_member', glofox_membership_type: 'num_classes', trial_credits_remaining: 5, glofox_membership_plan: 'Black Friday Open Week' })).toBe(false)
    expect(hasLiveMembership({ glofox_membership_status: 'credit_member', glofox_membership_type: 'num_classes', trial_credits_remaining: 5, glofox_membership_plan: '1 Class Pack' })).toBe(false)
    expect(hasLiveMembership({ glofox_membership_status: 'member', glofox_membership_type: 'time', glofox_membership_state: 'active', glofox_membership_plan: '1 Scan' })).toBe(false)
    // a normal subscription plan name stays live
    expect(hasLiveMembership({ glofox_membership_status: 'member', glofox_membership_type: 'time', glofox_membership_state: 'active', glofox_membership_plan: 'Month to Month Membership' })).toBe(true)
  })
  it('never treats a PAYG drop-in as a live membership', () => {
    expect(hasLiveMembership({ glofox_membership_type: 'payg' })).toBe(false)
    expect(hasLiveMembership({ glofox_membership_type: 'payg', glofox_membership_state: 'active' })).toBe(false)
  })
  it('treats a subscription as live unless its state says it ended', () => {
    expect(hasLiveMembership({ glofox_membership_type: 'time', glofox_membership_state: 'active' })).toBe(true)
    expect(hasLiveMembership({ glofox_membership_type: 'time', glofox_membership_state: 'paused' })).toBe(true)
    expect(hasLiveMembership({ glofox_membership_type: 'time', glofox_membership_state: 'locked' })).toBe(true)
    expect(hasLiveMembership({ glofox_membership_type: 'time', glofox_membership_state: 'cancelled' })).toBe(false)
    expect(hasLiveMembership({ glofox_membership_type: 'time', glofox_membership_state: 'expired' })).toBe(false)
  })
  it('treats an unknown / missing membership type as a subscription', () => {
    expect(hasLiveMembership({ glofox_membership_state: 'active' })).toBe(true)
    expect(hasLiveMembership({ glofox_membership_state: 'cancelled' })).toBe(false)
  })
  it('returns false for a missing contact', () => {
    expect(hasLiveMembership(null)).toBe(false)
  })
})

describe('isRealMembershipPlan (CHURN-CLEAN.1)', () => {
  it('rejects trial / open-week / taster / intro / scan / single-class plans', () => {
    for (const p of ['The UN1T Trial', 'Black Friday Open Week', 'Open Week', 'Taster Session',
      'Intro Offer', '1 Scan', 'InBody Scan', '1 Class Pack', '1 Class', 'Free Trial']) {
      expect(isRealMembershipPlan(p)).toBe(false)
    }
  })
  it('accepts real subscription + multi-class pack plans', () => {
    for (const p of ['Month to Month Membership', '3 Month Membership', '1 Year Membership',
      '10 Class Pack', '20 Class Pack', 'Elite Membership', 'Corporate']) {
      expect(isRealMembershipPlan(p)).toBe(true)
    }
  })
  it('treats a missing plan name as real (do not exclude on this signal alone)', () => {
    expect(isRealMembershipPlan(null)).toBe(true)
    expect(isRealMembershipPlan('')).toBe(true)
    expect(isRealMembershipPlan(undefined)).toBe(true)
  })
})

describe('live-membership gate — classifyContact', () => {
  it('drops a member+num_classes stale trial-pack reference out of scope (CHURN-CLEAN.1)', () => {
    expect(classifyContact({
      glofox_membership_status: 'member',
      glofox_membership_type: 'num_classes',
      trial_credits_remaining: 5,
      last_attended_at: daysAgo(2),
    })).toBe('out')
  })
  it('drops a trial-named plan out of scope even with credits (CHURN-CLEAN.1)', () => {
    expect(classifyContact(pack({ glofox_membership_plan: 'The UN1T Trial' }))).toBe('out')
  })
  it('drops a spent class pack (no credits) out of scope', () => {
    expect(classifyContact({
      glofox_membership_status: 'credit_member',
      glofox_membership_type: 'num_classes',
      trial_credits_remaining: 0,
      last_attended_at: daysAgo(2),
    })).toBe('out')
  })
  it('drops a PAYG drop-in out of scope even tagged as a member', () => {
    expect(classifyContact({
      glofox_membership_status: 'member',
      glofox_membership_type: 'payg',
      last_attended_at: daysAgo(2),
    })).toBe('out')
  })
  it('drops a cancelled / expired subscription out of scope', () => {
    expect(classifyContact(healthy({ glofox_membership_state: 'cancelled' }))).toBe('out')
    expect(classifyContact(healthy({ glofox_membership_state: 'expired' }))).toBe('out')
  })
  it('keeps a class pack with credits in scope', () => {
    expect(classifyContact(pack({ trial_credits_remaining: 1 }))).toBe('active')
  })
})

describe('scoreMember — no signal', () => {
  it('returns null for a healthy member', () => {
    expect(scoreMember(healthy(), NOW)).toBe(null)
  })
  it('returns null for an out-of-scope contact even with bad numbers', () => {
    expect(scoreMember({ glofox_membership_status: 'trial', last_attended_at: daysAgo(30) }, NOW)).toBe(null)
  })
  it('returns null for a quarantine member (no footprint)', () => {
    expect(scoreMember({ glofox_membership_status: 'member', last_attended_at: null, last_booked_at: null }, NOW)).toBe(null)
  })
})

describe('Gone quiet signal', () => {
  it('fires (warning) for 14-28 days quiet', () => {
    const r = scoreMember(healthy({ last_attended_at: daysAgo(20), total_attended_7d: 0, total_attended_30d: 2 }), NOW)
    const s = r.signals.find((x) => x.key === 'gone_quiet')
    expect(s).toBeTruthy()
    expect(s.severity).toBe('warning')
    expect(s.weight).toBe(2)
  })
  it('escalates (critical) past 28 days', () => {
    const r = scoreMember(healthy({ last_attended_at: daysAgo(35), total_attended_7d: 0, total_attended_30d: 0 }), NOW)
    const s = r.signals.find((x) => x.key === 'gone_quiet')
    expect(s.severity).toBe('critical')
    expect(s.weight).toBe(3)
  })
  it('does not fire under 14 days', () => {
    // Non-regular (2/30d) so Disengaging stays silent too — isolates Gone quiet.
    const r = scoreMember(healthy({
      last_attended_at: daysAgo(9), total_attended_30d: 2, total_attended_7d: 0, total_noshow_30d: 0,
    }), NOW)
    expect(r).toBe(null)
  })
  it('does not fire past 45 days (effectively churned, off-radar)', () => {
    expect(scoreMember(healthy({ last_attended_at: daysAgo(60), total_attended_7d: 0, total_attended_30d: 0 }), NOW)).toBe(null)
  })
})

describe('Disengaging signal', () => {
  it('fires for a regular with an empty last 7 days', () => {
    const r = scoreMember(healthy({ total_attended_30d: 6, total_attended_7d: 0, last_attended_at: daysAgo(9) }), NOW)
    const s = r.signals.find((x) => x.key === 'disengaging')
    expect(s).toBeTruthy()
    expect(s.weight).toBe(3)
  })
  it('does not fire for a non-regular', () => {
    const r = scoreMember(healthy({ total_attended_30d: 2, total_attended_7d: 0, last_attended_at: daysAgo(9) }), NOW)
    // total 2/30d isn't "regular" — no disengaging signal
    expect(r == null || !r.signals.some((x) => x.key === 'disengaging')).toBe(true)
  })
  it('does not fire if they attended in the last 7 days', () => {
    const r = scoreMember(healthy({ total_attended_30d: 6, total_attended_7d: 1 }), NOW)
    expect(r).toBe(null)
  })
})

describe('No-show signal', () => {
  it('fires (warning) for 2+ no-shows', () => {
    const r = scoreMember(healthy({ total_noshow_30d: 3, total_attended_30d: 8 }), NOW)
    const s = r.signals.find((x) => x.key === 'no_show')
    expect(s.weight).toBe(2)
    expect(s.severity).toBe('warning')
  })
  it('escalates when no-shows outnumber attendances', () => {
    const r = scoreMember(healthy({ total_noshow_30d: 5, total_attended_30d: 2, total_attended_7d: 0 }), NOW)
    const s = r.signals.find((x) => x.key === 'no_show')
    expect(s.weight).toBe(3)
    expect(s.severity).toBe('critical')
  })
  it('does not fire for a single no-show', () => {
    const r = scoreMember(healthy({ total_noshow_30d: 1 }), NOW)
    expect(r).toBe(null)
  })
})

describe('Payment-slipping signal', () => {
  // A recurring sub paid this many days ago, no other risk signals.
  const slip = (over = {}) => healthy({
    glofox_billing_interval: '1 month',
    last_payment_at: daysAgo(40),
    ...over,
  })

  it('fires critical for a monthly sub ~10 days past due', () => {
    const r = scoreMember(slip({ last_payment_at: daysAgo(40) }), NOW)
    const s = r.signals.find((x) => x.key === 'payment_slipping')
    expect(s.weight).toBe(3)
    expect(s.severity).toBe('critical')
    expect(s.detail).toMatch(/overdue/)
  })
  it('fires warning just past the grace window (<critical)', () => {
    // 34d − 30.44 ≈ 3.6d overdue: > grace (3), < critical (7)
    const r = scoreMember(slip({ last_payment_at: daysAgo(34) }), NOW)
    const s = r.signals.find((x) => x.key === 'payment_slipping')
    expect(s.severity).toBe('warning')
  })
  it('does not fire inside the grace window', () => {
    // 31d − 30.44 ≈ 0.6d overdue → within grace
    expect(scoreMember(slip({ last_payment_at: daysAgo(31) }), NOW)).toBe(null)
  })
  it('does not fire for a member paid on cycle', () => {
    expect(scoreMember(slip({ last_payment_at: daysAgo(5) }), NOW)).toBe(null)
  })
  it('does not fire without a last payment date', () => {
    expect(scoreMember(slip({ last_payment_at: null }), NOW)).toBe(null)
  })
  it('does not fire without a billing interval', () => {
    expect(scoreMember(slip({ glofox_billing_interval: null }), NOW)).toBe(null)
  })
  it('respects the billing cycle — a 3-month plan is not overdue at day 40', () => {
    expect(scoreMember(slip({ glofox_billing_interval: '3 months', last_payment_at: daysAgo(40) }), NOW)).toBe(null)
  })
  it('does not apply to class packs (paid upfront)', () => {
    // A pack with a stale "last payment" must not trip the sub signal.
    const r = scoreMember(pack({ last_payment_at: daysAgo(120), glofox_billing_interval: '1 month' }), NOW)
    expect((r?.signals || []).some((x) => x.key === 'payment_slipping')).toBe(false)
  })
  it('does not apply to PAYG', () => {
    const c = slip({ glofox_membership_type: 'payg', last_payment_at: daysAgo(120) })
    expect(scoreMember(c, NOW)).toBe(null)
  })
  it('tiers medium on its own (weight 3)', () => {
    const r = scoreMember(slip({ last_payment_at: daysAgo(40) }), NOW)
    expect(r.score).toBe(3)
    expect(r.tier).toBe('medium')
    expect(r.signals.length).toBe(1)
  })
})

describe('paymentTroubleKind — dunning guard', () => {
  it('flags a member with an open past-due invoice as overdue (RADAR-OVERDUE.1)', () => {
    const ctx = { pastDueIds: new Set(['c-healthy']) }
    expect(paymentTroubleKind(healthy(), NOW, ctx)).toBe('overdue')
  })
  it('flags an active past-due sub as slipping', () => {
    const c = healthy({ glofox_billing_interval: '1 month', last_payment_at: daysAgo(40) })
    expect(paymentTroubleKind(c, NOW)).toBe('slipping')
  })
  it('returns null for a paying active member', () => {
    expect(paymentTroubleKind(healthy({ glofox_billing_interval: '1 month', last_payment_at: daysAgo(5) }), NOW)).toBe(null)
  })
  it('returns null for a paused member (planned freeze, not behind)', () => {
    expect(paymentTroubleKind(healthy({ glofox_membership_state: 'paused' }), NOW)).toBe(null)
  })
  it('returns null for a non-member', () => {
    expect(paymentTroubleKind({ glofox_membership_status: 'lead' }, NOW)).toBe(null)
  })
})

// RADAR-PAY.2 — the post-refresh verdict the refresh-member route returns.
// The re-read `fresh` row is selected with STATE_COLUMNS — it has NO `id` —
// and both classifyContact AND paymentTroubleKind need ctx.pastDueIds to see
// open arrears, so this helper must inject the id and feed the same ctx to
// both. Bug it fixes: the route called classifyContact(fresh || {}) with no
// ctx + no id, so a member who genuinely owes could never read 'overdue' and
// (when their subscription wasn't separately "slipping") fell through to
// still_flagged=false and wrongly dropped off the list.
describe('classifyRefreshedMember — RADAR-PAY.2 post-refresh verdict', () => {
  // Simulate the route's STATE_COLUMNS re-read: same shape, but no id/name.
  const freshRow = (over = {}) => {
    const r = healthy(over)
    delete r.id
    delete r.name
    return r
  }

  it('classifies a member with open past-due invoices as overdue (injects the id + ctx the route lacks)', () => {
    // freshRow has NO id; only the helper injecting id='c-john' makes the
    // ctx.pastDueIds match — so 'overdue' proves the injection works.
    const res = classifyRefreshedMember(freshRow(), 'c-john', 2, NOW)
    expect(res.classification).toBe('overdue')
    expect(res.trouble).toBe('overdue')
    expect(res.stillFlagged).toBe(true)
  })

  it('keeps a member flagged when they owe a fee even though their subscription is current (the previously-masked case)', () => {
    // Recent payment → detectPaymentSlipping does NOT fire, so the old
    // `trouble` fallback was null; only the overdue ctx keeps them flagged.
    const res = classifyRefreshedMember(
      freshRow({ glofox_billing_interval: '1 month', last_payment_at: daysAgo(5) }),
      'c-john', 6, NOW,
    )
    expect(res.classification).toBe('overdue')
    expect(res.stillFlagged).toBe(true)
  })

  it('does not flag a paid-up member with no past-due as overdue', () => {
    const res = classifyRefreshedMember(
      freshRow({ glofox_billing_interval: '1 month', last_payment_at: daysAgo(5) }),
      'c-john', 0, NOW,
    )
    expect(res.classification).toBe('active')
    expect(res.trouble).toBe(null)
    expect(res.stillFlagged).toBe(false)
  })

  it('still reports slipping (stillFlagged) for an active sub past due with no open invoice rows', () => {
    const res = classifyRefreshedMember(
      freshRow({ glofox_billing_interval: '1 month', last_payment_at: daysAgo(40) }),
      'c-john', 0, NOW,
    )
    expect(res.classification).toBe('active')
    expect(res.trouble).toBe('slipping')
    expect(res.stillFlagged).toBe(true)
  })
})

describe('scoreMember — combined score + tier', () => {
  it('sums weights across signals and tiers high', () => {
    // Gone quiet 35d (3, critical) + no-show heavy (3) = 6 → high
    const r = scoreMember(healthy({
      last_attended_at: daysAgo(35), total_attended_7d: 0, total_attended_30d: 1, total_noshow_30d: 4,
    }), NOW)
    expect(r.signals.length).toBe(2)
    expect(r.score).toBe(6)
    expect(r.tier).toBe('high')
    expect(r.daysSinceAttended).toBe(35)
  })
  it('tiers medium for a single mid-weight signal', () => {
    const r = scoreMember(healthy({ total_attended_30d: 6, total_attended_7d: 0, last_attended_at: daysAgo(8) }), NOW)
    expect(r.score).toBe(3)
    expect(r.tier).toBe('medium')
  })
})

describe('buildRadar', () => {
  it('returns only at-risk members, highest score first', () => {
    const contacts = [
      healthy(),
      healthy({ id: 'c-quiet', name: 'Quiet', last_attended_at: daysAgo(20), total_attended_7d: 0, total_attended_30d: 2 }),
      healthy({ id: 'c-bad', name: 'Bad', last_attended_at: daysAgo(35), total_attended_7d: 0, total_attended_30d: 1, total_noshow_30d: 4 }),
      { id: 'c-trial', glofox_membership_status: 'trial', last_attended_at: daysAgo(40) },
      { id: 'c-quar', glofox_membership_status: 'member', last_attended_at: null, last_booked_at: null },
    ]
    const radar = buildRadar(contacts, NOW)
    expect(radar.map((r) => r.contactId)).toEqual(['c-bad', 'c-quiet'])
    expect(radar[0].score).toBeGreaterThan(radar[1].score)
  })
  it('returns [] for empty / null input', () => {
    expect(buildRadar([], NOW)).toEqual([])
    expect(buildRadar(null, NOW)).toEqual([])
  })
})

describe('radarSummary', () => {
  it('counts the live active base (active + paused + overdue + quarantine), split by membership type', () => {
    const contacts = [
      healthy(),
      healthy({ id: 'c-quiet', last_attended_at: daysAgo(20), total_attended_7d: 0, total_attended_30d: 2 }),
      healthy({ id: 'c-bad', last_attended_at: daysAgo(35), total_attended_7d: 0, total_attended_30d: 1, total_noshow_30d: 4 }),
      pack({ id: 'c-pack' }),
      healthy({ id: 'c-quar1', last_attended_at: null, last_booked_at: null }),
      pack({ id: 'c-quar2', last_attended_at: null, last_booked_at: null }),
      healthy({ id: 'c-paused', glofox_membership_state: 'paused' }),
      healthy({ id: 'c-overdue', glofox_membership_price_cents: 17900, glofox_billing_interval: '1 month' }),
      { id: 'c-trial', glofox_membership_status: 'trial' },
      { id: 'c-payg', glofox_membership_status: 'member', glofox_membership_type: 'payg', last_attended_at: daysAgo(2) },
    ]
    // RADAR-OVERDUE.1 — c-overdue has an open €179 past-due invoice.
    const ctx = {
      pastDueIds: new Set(['c-overdue']),
      pastDueById: new Map([['c-overdue', { amountCents: 17900, count: 1, oldestDueAt: daysAgo(10) }]]),
    }
    const s = radarSummary(contacts, NOW, ctx)
    expect(s.activeBase).toBe(8)   // 6 subs + 2 packs; payg + trial out of scope
    expect(s.atRisk).toBe(2)       // c-quiet, c-bad
    expect(s.highRisk).toBe(1)     // c-bad
    expect(s.quarantine).toBe(2)   // c-quar1, c-quar2
    expect(s.paused).toBe(1)       // c-paused
    expect(s.overdue).toBe(1)      // c-overdue (open past-due invoice)
    expect(s.overdueValueCents).toBe(17900)  // the real amount owed, from the invoice
    expect(s.bySegment.member).toEqual({ activeBase: 6, atRisk: 2, highRisk: 1 })
    expect(s.bySegment.credit).toEqual({ activeBase: 2, atRisk: 0, highRisk: 0 })
  })
})

describe('paused / overdue membership states', () => {
  it('classifies a paused membership as paused (still a live member)', () => {
    expect(classifyContact(healthy({ glofox_membership_state: 'paused' }))).toBe('paused')
  })
  it('scores active, unknown and missing states normally', () => {
    expect(classifyContact(healthy({ glofox_membership_state: 'active' }))).toBe('active')
    expect(classifyContact(healthy({ glofox_membership_state: null }))).toBe('active')
    expect(classifyContact(healthy({ glofox_membership_state: 'something_else' }))).toBe('active')
  })
  it('scoreMember returns null for a paused member even when signals fire', () => {
    const wouldBeAtRisk = healthy({
      glofox_membership_state: 'paused',
      last_attended_at: daysAgo(35), total_attended_7d: 0, total_attended_30d: 1, total_noshow_30d: 4,
    })
    expect(scoreMember(wouldBeAtRisk, NOW)).toBe(null)
  })
  it('scoreMember returns null for an overdue member even when signals fire (RADAR-OVERDUE.1)', () => {
    const wouldBeAtRisk = healthy({
      last_attended_at: daysAgo(35), total_attended_7d: 0, total_attended_30d: 1, total_noshow_30d: 4,
    })
    expect(scoreMember(wouldBeAtRisk, NOW, { pastDueIds: new Set(['c-healthy']) })).toBe(null)
  })
  it('keeps paused + overdue members out of buildRadar', () => {
    const contacts = [
      healthy({ id: 'c-bad', last_attended_at: daysAgo(35), total_attended_7d: 0, total_attended_30d: 1, total_noshow_30d: 4 }),
      healthy({ id: 'c-paused', glofox_membership_state: 'paused', last_attended_at: daysAgo(35), total_attended_7d: 0, total_attended_30d: 1, total_noshow_30d: 4 }),
      healthy({ id: 'c-overdue', last_attended_at: daysAgo(35), total_attended_7d: 0, total_attended_30d: 1, total_noshow_30d: 4 }),
    ]
    const ctx = { pastDueIds: new Set(['c-overdue']) }
    expect(buildRadar(contacts, NOW, ctx).map((r) => r.contactId)).toEqual(['c-bad'])
  })
})

describe('segment', () => {
  it('tags scored members member vs credit off the membership type', () => {
    const m = scoreMember(healthy({ last_attended_at: daysAgo(20), total_attended_7d: 0, total_attended_30d: 2 }), NOW)
    expect(m.segment).toBe('member')
    const c = scoreMember(pack({
      last_attended_at: daysAgo(20), total_attended_7d: 0, total_attended_30d: 2,
    }), NOW)
    expect(c.segment).toBe('credit')
  })
})

describe('monthlyValueCents', () => {
  it('normalises a multi-month price to monthly', () => {
    expect(monthlyValueCents({ glofox_membership_price_cents: 101300, glofox_billing_interval: '6 months' })).toBe(16883)
  })
  it('passes a monthly price straight through', () => {
    expect(monthlyValueCents({ glofox_membership_price_cents: 17900, glofox_billing_interval: '1 month' })).toBe(17900)
  })
  it('normalises a yearly price', () => {
    expect(monthlyValueCents({ glofox_membership_price_cents: 120000, glofox_billing_interval: '1 year' })).toBe(10000)
  })
  it('uses the raw figure when there is no interval (class pack)', () => {
    expect(monthlyValueCents({ glofox_membership_price_cents: 2000, glofox_billing_interval: null })).toBe(2000)
  })
  it('returns 0 when there is no price', () => {
    expect(monthlyValueCents({})).toBe(0)
    expect(monthlyValueCents({ glofox_membership_price_cents: 0 })).toBe(0)
  })
})

describe('Renewal-cliff signal', () => {
  it('fires (warning) when the membership renews soon and attendance is low', () => {
    const r = scoreMember(healthy({
      glofox_membership_expiry: daysAhead(20), total_attended_30d: 1, total_attended_7d: 0,
    }), NOW)
    const s = r.signals.find((x) => x.key === 'renewal_cliff')
    expect(s).toBeTruthy()
    expect(s.severity).toBe('warning')
  })
  it('escalates to critical inside 14 days', () => {
    const r = scoreMember(healthy({
      glofox_membership_expiry: daysAhead(10), total_attended_30d: 1, total_attended_7d: 0,
    }), NOW)
    expect(r.signals.find((x) => x.key === 'renewal_cliff').severity).toBe('critical')
  })
  it('does not fire for a regular attender — they will renew', () => {
    const r = scoreMember(healthy({ glofox_membership_expiry: daysAhead(10) }), NOW)
    expect(r == null || !r.signals.some((x) => x.key === 'renewal_cliff')).toBe(true)
  })
  it('does not fire when renewal is far off', () => {
    const r = scoreMember(healthy({
      glofox_membership_expiry: daysAhead(90), total_attended_30d: 1, total_attended_7d: 0,
    }), NOW)
    expect(r == null || !r.signals.some((x) => x.key === 'renewal_cliff')).toBe(true)
  })
})

describe('RADAR-LOW.1 — Pack running-low signal', () => {
  it('fires (critical) for a pack down to its last class', () => {
    const r = scoreMember(pack({ trial_credits_remaining: 1 }), NOW)
    const s = r.signals.find((x) => x.key === 'pack_low')
    expect(s).toBeTruthy()
    expect(s.severity).toBe('critical')
    expect(s.weight).toBe(3)
  })
  it('fires (warning) at 2 classes left', () => {
    const r = scoreMember(pack({ trial_credits_remaining: 2 }), NOW)
    const s = r.signals.find((x) => x.key === 'pack_low')
    expect(s.severity).toBe('warning')
    expect(s.weight).toBe(2)
  })
  it('does not fire for a pack with classes to spare', () => {
    const r = scoreMember(pack({ trial_credits_remaining: 5 }), NOW)
    expect(r == null || !r.signals.some((x) => x.key === 'pack_low')).toBe(true)
  })
  it('does not fire for a subscription member with a stray credits value', () => {
    const r = scoreMember(healthy({ trial_credits_remaining: 1 }), NOW)
    expect(r == null || !r.signals.some((x) => x.key === 'pack_low')).toBe(true)
  })
  it('stacks with gone-quiet for a lapsing low pack', () => {
    const r = scoreMember(pack({
      trial_credits_remaining: 1,
      last_attended_at: daysAgo(20), total_attended_7d: 0, total_attended_30d: 2,
    }), NOW)
    expect(r.signals.map((s) => s.key).sort()).toEqual(['gone_quiet', 'pack_low'])
    expect(r.score).toBe(5)        // pack_low 3 + gone_quiet 2
    expect(r.tier).toBe('high')
  })
})

describe('revenue weighting', () => {
  it('scoreMember carries the monthly value + days to renewal', () => {
    const r = scoreMember(healthy({
      last_attended_at: daysAgo(20), total_attended_7d: 0, total_attended_30d: 2,
      glofox_membership_price_cents: 101300, glofox_billing_interval: '6 months',
      glofox_membership_expiry: daysAhead(40),
    }), NOW)
    expect(r.monthlyValueCents).toBe(16883)
    expect(r.daysToRenewal).toBe(40)
  })
  it('radarSummary sums monthly revenue at risk', () => {
    const contacts = [
      healthy({ id: 'r1', last_attended_at: daysAgo(20), total_attended_7d: 0, total_attended_30d: 2,
        glofox_membership_price_cents: 17900, glofox_billing_interval: '1 month' }),
      healthy({ id: 'r2', last_attended_at: daysAgo(20), total_attended_7d: 0, total_attended_30d: 2,
        glofox_membership_price_cents: 12000, glofox_billing_interval: '1 month' }),
      healthy(),
    ]
    expect(radarSummary(contacts, NOW).revenueAtRiskCents).toBe(29900)
  })
  it('buildRadar ranks the higher-value member first within a tier', () => {
    const contacts = [
      healthy({ id: 'low', last_attended_at: daysAgo(20), total_attended_7d: 0, total_attended_30d: 2,
        glofox_membership_price_cents: 5000, glofox_billing_interval: '1 month' }),
      healthy({ id: 'high', last_attended_at: daysAgo(20), total_attended_7d: 0, total_attended_30d: 2,
        glofox_membership_price_cents: 20000, glofox_billing_interval: '1 month' }),
    ]
    expect(buildRadar(contacts, NOW).map((r) => r.contactId)).toEqual(['high', 'low'])
  })
})

describe('MEMBER_STATUSES', () => {
  it('is the paying-member set', () => {
    expect(MEMBER_STATUSES).toEqual(['member', 'credit_member'])
  })
})

describe('RADAR-OVERDUE.1 — buildOverdue (invoice-driven)', () => {
  it('lists only contacts with an open past-due invoice, highest amount owed first', () => {
    const ctx = {
      pastDueById: new Map([
        ['low', { amountCents: 8000, count: 1, oldestDueAt: daysAgo(40) }],
        ['high', { amountCents: 20000, count: 2, oldestDueAt: daysAgo(20) }],
      ]),
    }
    const rows = buildOverdue([
      healthy({ id: 'ok' }),
      healthy({ id: 'paused', glofox_membership_state: 'paused' }),
      healthy({ id: 'low' }),
      healthy({ id: 'high' }),
    ], NOW, ctx)
    expect(rows.map((r) => r.contactId)).toEqual(['high', 'low'])
    expect(rows[0].amountOwedCents).toBe(20000)
    expect(rows[0].invoiceCount).toBe(2)
    expect(rows[0].daysOverdue).toBe(20)
  })
  it('includes a class pack ONLY when it carries a real past-due invoice (never from membership state)', () => {
    // A normal pack (no invoice) is absent; one with a genuine unpaid invoice shows.
    const ctx = { pastDueById: new Map([['owes', { amountCents: 2500, count: 1, oldestDueAt: daysAgo(5) }]]) }
    const rows = buildOverdue([pack({ id: 'fine' }), pack({ id: 'owes' })], NOW, ctx)
    expect(rows.map((r) => r.contactId)).toEqual(['owes'])
    expect(rows[0].segment).toBe('credit')
  })
  it('carries amount, attendance recency and the segment', () => {
    const ctx = { pastDueById: new Map([['sub', { amountCents: 17900, count: 1, oldestDueAt: daysAgo(35) }]]) }
    const rows = buildOverdue([
      healthy({ id: 'sub', last_attended_at: daysAgo(3) }),
    ], NOW, ctx)
    expect(rows[0].segment).toBe('member')
    expect(rows[0].amountOwedCents).toBe(17900)
    expect(rows[0].daysOverdue).toBe(35)
    expect(rows[0].daysSinceAttended).toBe(3)
  })
  it('returns [] for empty / null input or no past-due context', () => {
    expect(buildOverdue([], NOW, { pastDueById: new Map() })).toEqual([])
    expect(buildOverdue(null, NOW, { pastDueById: new Map() })).toEqual([])
    expect(buildOverdue([healthy()], NOW)).toEqual([])  // no ctx → nobody overdue
  })
})

describe('WINBACK.1 — scoreWinbackContact', () => {
  it('scores a member who last trained inside the win-back window', () => {
    const r = scoreWinbackContact(
      { id: 'w1', name: 'Jess', glofox_membership_status: 'member', last_attended_at: daysAgo(81) }, NOW)
    expect(r).not.toBeNull()
    expect(r.daysSinceAttended).toBe(81)
    expect(r.tier).toBe('high')   // <= 90 days
  })

  it('includes ex_member contacts with a real footprint', () => {
    const r = scoreWinbackContact(
      { id: 'w2', glofox_membership_status: 'ex_member', last_attended_at: daysAgo(150) }, NOW)
    expect(r).not.toBeNull()
    expect(r.tier).toBe('medium') // <= 180 days
  })

  it('returns null inside the at-risk window (<= 45 days quiet)', () => {
    expect(scoreWinbackContact(
      { id: 'w3', glofox_membership_status: 'member', last_attended_at: daysAgo(30) }, NOW)).toBeNull()
  })

  it('returns null past the win-back ceiling (gone over a year)', () => {
    expect(scoreWinbackContact(
      { id: 'w4', glofox_membership_status: 'member', last_attended_at: daysAgo(400) }, NOW)).toBeNull()
  })

  it('returns null for a member with no attendance footprint (a ghost, not a win-back)', () => {
    expect(scoreWinbackContact(
      { id: 'w5', glofox_membership_status: 'member', last_attended_at: null }, NOW)).toBeNull()
  })

  it('excludes a planned freeze (paused / frozen) — they intend to return', () => {
    expect(scoreWinbackContact(
      { id: 'w6', glofox_membership_status: 'member', glofox_membership_state: 'paused', last_attended_at: daysAgo(81) }, NOW)).toBeNull()
  })

  it('returns null for a non-member status (trial / lead)', () => {
    expect(scoreWinbackContact(
      { id: 'w7', glofox_membership_status: 'trial', last_attended_at: daysAgo(81) }, NOW)).toBeNull()
  })

  it('returns null for a trial-named plan — never a real member to win back (CHURN-CLEAN.1)', () => {
    expect(scoreWinbackContact(
      { id: 'w8', glofox_membership_status: 'member', glofox_membership_plan: 'The UN1T Trial', last_attended_at: daysAgo(81) }, NOW)).toBeNull()
  })

  it('returns null for a member+num_classes stale trial-pack reference (CHURN-CLEAN.1)', () => {
    expect(scoreWinbackContact(
      { id: 'w9', glofox_membership_status: 'member', glofox_membership_type: 'num_classes', last_attended_at: daysAgo(81) }, NOW)).toBeNull()
  })

  it('tiers by recency — 90<d<=180 medium, >180 low', () => {
    const mk = (d) => scoreWinbackContact(
      { id: 'x', glofox_membership_status: 'member', last_attended_at: daysAgo(d) }, NOW).tier
    expect(mk(60)).toBe('high')
    expect(mk(120)).toBe('medium')
    expect(mk(300)).toBe('low')
  })
})

describe('WINBACK.1 — buildWinback', () => {
  it('returns only win-back candidates, warmest + highest-value first', () => {
    const rows = buildWinback([
      { id: 'active', glofox_membership_status: 'member', last_attended_at: daysAgo(10) },
      { id: 'gone', glofox_membership_status: 'member', last_attended_at: daysAgo(500) },
      { id: 'cold-cheap', glofox_membership_status: 'member', last_attended_at: daysAgo(200) },
      { id: 'warm', glofox_membership_status: 'member', last_attended_at: daysAgo(60) },
      { id: 'warm-rich', glofox_membership_status: 'member', last_attended_at: daysAgo(70),
        glofox_membership_price_cents: 20000, glofox_billing_interval: '1 month' },
    ], NOW)
    // high tier first (warm-rich + warm), rich before cheap; then low (cold-cheap).
    expect(rows.map((r) => r.contactId)).toEqual(['warm-rich', 'warm', 'cold-cheap'])
  })
})

describe('RADAR-OUTCOMES.1 — computeRecoveryStats', () => {
  const action = (contactId, type, daysAgoN) => ({
    contact_id: contactId, action: type, created_at: daysAgo(daysAgoN),
  })

  it('counts a contacted member who trained again as recovered', () => {
    const r = computeRecoveryStats(
      [{ id: 'm1', last_attended_at: daysAgo(10) }],
      [action('m1', 'contacted', 30)], NOW)
    expect(r).toEqual({ contacted: 1, recovered: 1, recoveryRate: 1 })
  })

  it('does not count a member who never trained after the intervention', () => {
    const r = computeRecoveryStats(
      [{ id: 'm1', last_attended_at: daysAgo(40) }],   // last class predates the contact
      [action('m1', 'contacted', 30)], NOW)
    expect(r).toEqual({ contacted: 1, recovered: 0, recoveryRate: 0 })
  })

  it('counts an outreach_sent action as an intervention (RADAR-OUTREACH.1)', () => {
    const r = computeRecoveryStats(
      [{ id: 'm1', last_attended_at: daysAgo(10) }],
      [action('m1', 'outreach_sent', 30)], NOW)
    expect(r).toEqual({ contacted: 1, recovered: 1, recoveryRate: 1 })
  })

  it('computes the rate across a batch', () => {
    const contacts = [
      { id: 'a', last_attended_at: daysAgo(5) },    // recovered
      { id: 'b', last_attended_at: daysAgo(50) },   // attended before the contact
      { id: 'c', last_attended_at: null },          // never came back
      { id: 'd', last_attended_at: daysAgo(2) },    // recovered
    ]
    const actions = [
      action('a', 'contacted', 30), action('b', 'winback_sent', 30),
      action('c', 'task_assigned', 30), action('d', 'contacted', 30),
    ]
    const r = computeRecoveryStats(contacts, actions, NOW)
    expect(r.contacted).toBe(4)
    expect(r.recovered).toBe(2)
    expect(r.recoveryRate).toBe(0.5)
  })

  it('excludes interventions too recent to judge (grace period)', () => {
    expect(computeRecoveryStats(
      [{ id: 'm1', last_attended_at: daysAgo(1) }],
      [action('m1', 'contacted', 2)], NOW)).toEqual({ contacted: 0, recovered: 0, recoveryRate: 0 })
  })

  it('excludes interventions older than the 90-day window', () => {
    expect(computeRecoveryStats(
      [{ id: 'm1', last_attended_at: daysAgo(10) }],
      [action('m1', 'contacted', 120)], NOW).contacted).toBe(0)
  })

  it('uses the earliest in-window intervention as the baseline', () => {
    const r = computeRecoveryStats(
      [{ id: 'm1', last_attended_at: daysAgo(45) }],
      [action('m1', 'contacted', 60), action('m1', 'winback_sent', 20)], NOW)
    expect(r.recovered).toBe(1)
  })

  it('ignores non-intervention actions (snooze, quarantine triage)', () => {
    const r = computeRecoveryStats(
      [{ id: 'm1', last_attended_at: daysAgo(5) }],
      [action('m1', 'snoozed', 30), action('m1', 'quarantine_stale', 30)], NOW)
    expect(r.contacted).toBe(0)
  })

  it('returns zeroes for empty / null input', () => {
    expect(computeRecoveryStats([], [], NOW)).toEqual({ contacted: 0, recovered: 0, recoveryRate: 0 })
    expect(computeRecoveryStats(null, null, NOW)).toEqual({ contacted: 0, recovered: 0, recoveryRate: 0 })
  })
})

describe('RADAR-TREND.1 — computeTrend', () => {
  const summary = {
    activeBase: 268, atRisk: 40, highRisk: 12, overdue: 11,
    paused: 17, quarantine: 5, revenueAtRiskCents: 80000, overdueValueCents: 19000,
  }

  it('diffs the live summary against the latest snapshot', () => {
    const snapshot = {
      captured_at: '2026-05-15T06:00:00.000Z',
      active_base: 272, at_risk: 38, high_risk: 10, overdue: 8,
      paused: 17, quarantine: 9, revenue_at_risk_cents: 76000, overdue_value_cents: 14000,
    }
    const t = computeTrend(summary, snapshot)
    expect(t.since).toBe('2026-05-15T06:00:00.000Z')
    expect(t.deltas.activeBase).toBe(-4)
    expect(t.deltas.atRisk).toBe(2)
    expect(t.deltas.highRisk).toBe(2)
    expect(t.deltas.overdue).toBe(3)
    expect(t.deltas.paused).toBe(0)
    expect(t.deltas.quarantine).toBe(-4)
    expect(t.deltas.revenueAtRiskCents).toBe(4000)
    expect(t.deltas.overdueValueCents).toBe(5000)
  })

  it('returns null when there is no snapshot to compare against', () => {
    expect(computeTrend(summary, null)).toBeNull()
    expect(computeTrend(null, {})).toBeNull()
  })

  it('treats missing snapshot columns as zero', () => {
    const t = computeTrend(summary, { captured_at: '2026-05-15T06:00:00.000Z' })
    expect(t.deltas.activeBase).toBe(268)   // 268 − 0
    expect(t.deltas.overdue).toBe(11)
  })
})

// ARREARS-TYPE.1 — tabs route by CHARGE TYPE, not by amount. The split itself
// (isMembershipInvoice) happens in fetchPastDue; bucketArrears maps its three
// per-contact maps onto the tabs and drops empty aggregates.
describe('bucketArrears — by charge type (ARREARS-TYPE.1)', () => {
  const M = (entries) => new Map(entries)
  const agg = (amountCents, oldestDueAt = '2026-05-01') => ({ amountCents, count: 1, oldestDueAt })

  it('routes PAST_DUE membership payments → Overdue at ANY amount (a €25 failed renewal)', () => {
    const { overdueById, unpaidById, awaitingAuthById } = bucketArrears({ membershipById: M([['r', agg(2500)]]) })
    expect(overdueById.get('r')?.amountCents).toBe(2500)
    expect(unpaidById.size).toBe(0)
    expect(awaitingAuthById.size).toBe(0)
  })

  it('routes every other PAST_DUE charge → Unpaid charges at ANY amount (a €380 failed class pack)', () => {
    const { overdueById, unpaidById, awaitingAuthById } = bucketArrears({ chargesById: M([['p', agg(38000)]]) })
    expect(overdueById.size).toBe(0)
    expect(unpaidById.get('p')?.amountCents).toBe(38000)
    expect(awaitingAuthById.size).toBe(0)
  })

  it('routes PENDING → Awaiting authorization only, even a €510 renewal in progress', () => {
    const { overdueById, unpaidById, awaitingAuthById } = bucketArrears({ pendingById: M([['a', agg(51000)]]) })
    expect(overdueById.size).toBe(0)
    expect(unpaidById.size).toBe(0)
    expect(awaitingAuthById.get('a')?.amountCents).toBe(51000)
  })

  it('puts the SAME contact in Overdue and Unpaid charges with separate amounts (failed renewal + failed fee)', () => {
    const { overdueById, unpaidById, awaitingAuthById } = bucketArrears({
      membershipById: M([['c', agg(19900, '2026-05-01')]]),
      chargesById: M([['c', agg(1000, '2026-05-20')]]),
      pendingById: M([['c', agg(500, '2026-05-26')]]),
    })
    expect(overdueById.get('c')).toMatchObject({ amountCents: 19900, oldestDueAt: '2026-05-01' })
    expect(unpaidById.get('c')).toMatchObject({ amountCents: 1000, oldestDueAt: '2026-05-20' })
    expect(awaitingAuthById.get('c')).toMatchObject({ amountCents: 500, oldestDueAt: '2026-05-26' })
  })

  it('drops zero-amount aggregates and tolerates missing maps / no argument', () => {
    const { overdueById, unpaidById, awaitingAuthById } = bucketArrears({ membershipById: M([['z', agg(0)]]) })
    expect(overdueById.size).toBe(0)
    expect(unpaidById.size).toBe(0)
    expect(awaitingAuthById.size).toBe(0)
    expect(bucketArrears(undefined)).toEqual({ overdueById: new Map(), unpaidById: new Map(), awaitingAuthById: new Map() })
    expect(bucketArrears({ membershipById: null, chargesById: 'nope' })).toEqual({ overdueById: new Map(), unpaidById: new Map(), awaitingAuthById: new Map() })
  })
})
