// Tests for churn-radar.js — pure scoring, deterministic against a
// fixed "now".

import { describe, it, expect } from 'vitest'
import {
  classifyContact,
  hasLiveMembership,
  scoreMember,
  buildRadar,
  radarSummary,
  buildOverdue,
  monthlyValueCents,
  scoreWinbackContact,
  buildWinback,
  computeRecoveryStats,
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
  it('marks a locked (payment-failed) membership as overdue', () => {
    expect(classifyContact(healthy({ glofox_membership_state: 'locked' }))).toBe('overdue')
    // overdue is decided before the footprint check
    expect(classifyContact(healthy({
      glofox_membership_state: 'locked', last_attended_at: null, last_booked_at: null,
    }))).toBe('overdue')
  })
})

describe('hasLiveMembership', () => {
  it('treats a class pack as live only while credits remain', () => {
    expect(hasLiveMembership({ glofox_membership_type: 'num_classes', trial_credits_remaining: 3 })).toBe(true)
    expect(hasLiveMembership({ glofox_membership_type: 'num_classes', trial_credits_remaining: 0 })).toBe(false)
    expect(hasLiveMembership({ glofox_membership_type: 'num_classes', trial_credits_remaining: null })).toBe(false)
    expect(hasLiveMembership({ glofox_membership_type: 'num_classes' })).toBe(false)
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

describe('live-membership gate — classifyContact', () => {
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
      healthy({ id: 'c-overdue', glofox_membership_state: 'locked',
        glofox_membership_price_cents: 17900, glofox_billing_interval: '1 month' }),
      { id: 'c-trial', glofox_membership_status: 'trial' },
      { id: 'c-payg', glofox_membership_status: 'member', glofox_membership_type: 'payg', last_attended_at: daysAgo(2) },
    ]
    const s = radarSummary(contacts, NOW)
    expect(s.activeBase).toBe(8)   // 6 subs + 2 packs; payg + trial out of scope
    expect(s.atRisk).toBe(2)       // c-quiet, c-bad
    expect(s.highRisk).toBe(1)     // c-bad
    expect(s.quarantine).toBe(2)   // c-quar1, c-quar2
    expect(s.paused).toBe(1)       // c-paused
    expect(s.overdue).toBe(1)      // c-overdue
    expect(s.overdueValueCents).toBe(17900)
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
  it('scoreMember returns null for an overdue member even when signals fire', () => {
    const wouldBeAtRisk = healthy({
      glofox_membership_state: 'locked',
      last_attended_at: daysAgo(35), total_attended_7d: 0, total_attended_30d: 1, total_noshow_30d: 4,
    })
    expect(scoreMember(wouldBeAtRisk, NOW)).toBe(null)
  })
  it('keeps paused + overdue members out of buildRadar', () => {
    const contacts = [
      healthy({ id: 'c-bad', last_attended_at: daysAgo(35), total_attended_7d: 0, total_attended_30d: 1, total_noshow_30d: 4 }),
      healthy({ id: 'c-paused', glofox_membership_state: 'paused', last_attended_at: daysAgo(35), total_attended_7d: 0, total_attended_30d: 1, total_noshow_30d: 4 }),
      healthy({ id: 'c-overdue', glofox_membership_state: 'locked', last_attended_at: daysAgo(35), total_attended_7d: 0, total_attended_30d: 1, total_noshow_30d: 4 }),
    ]
    expect(buildRadar(contacts, NOW).map((r) => r.contactId)).toEqual(['c-bad'])
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

describe('OVERDUE.1 — buildOverdue', () => {
  it('lists only locked (payment-failed) members, highest value first', () => {
    const rows = buildOverdue([
      healthy({ id: 'ok' }),
      healthy({ id: 'paused', glofox_membership_state: 'paused' }),
      healthy({ id: 'low', glofox_membership_state: 'locked',
        glofox_membership_price_cents: 8000, glofox_billing_interval: '1 month',
        last_payment_at: daysAgo(40) }),
      healthy({ id: 'high', glofox_membership_state: 'locked',
        glofox_membership_price_cents: 20000, glofox_billing_interval: '1 month',
        last_payment_at: daysAgo(20) }),
    ], NOW)
    expect(rows.map((r) => r.contactId)).toEqual(['high', 'low'])
    expect(rows[0].monthlyValueCents).toBe(20000)
    expect(rows[0].daysSincePayment).toBe(20)
  })
  it('carries payment + attendance recency and the segment', () => {
    const rows = buildOverdue([
      healthy({ id: 'sub', glofox_membership_state: 'locked',
        last_payment_at: daysAgo(35), last_attended_at: daysAgo(3) }),
    ], NOW)
    expect(rows[0].segment).toBe('member')
    expect(rows[0].daysSincePayment).toBe(35)
    expect(rows[0].daysSinceAttended).toBe(3)
  })
  it('returns [] for empty / null input', () => {
    expect(buildOverdue([], NOW)).toEqual([])
    expect(buildOverdue(null, NOW)).toEqual([])
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
