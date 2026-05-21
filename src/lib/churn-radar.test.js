// Tests for churn-radar.js — pure scoring, deterministic against a
// fixed "now".

import { describe, it, expect } from 'vitest'
import {
  classifyContact,
  scoreMember,
  buildRadar,
  radarSummary,
  MEMBER_STATUSES,
} from './churn-radar.js'

const NOW = Date.parse('2026-05-21T12:00:00.000Z')
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString()

// A healthy active member — paying, attended yesterday, regular.
function healthy(over = {}) {
  return {
    id: 'c-healthy',
    name: 'Healthy Member',
    glofox_membership_status: 'member',
    last_attended_at: daysAgo(1),
    last_booked_at: daysAgo(1),
    total_attended_30d: 10,
    total_attended_7d: 3,
    total_noshow_30d: 0,
    total_bookings_30d: 10,
    ...over,
  }
}

describe('classifyContact', () => {
  it('marks non-members as out of scope', () => {
    expect(classifyContact({ glofox_membership_status: 'trial' })).toBe('out')
    expect(classifyContact({ glofox_membership_status: 'lead' })).toBe('out')
    expect(classifyContact(null)).toBe('out')
  })
  it('marks a member with an activity footprint as active', () => {
    expect(classifyContact(healthy())).toBe('active')
    expect(classifyContact(healthy({ last_attended_at: null }))).toBe('active') // last_booked_at still set
  })
  it('marks a member with no footprint as quarantine', () => {
    expect(classifyContact({
      glofox_membership_status: 'member', last_attended_at: null, last_booked_at: null,
    })).toBe('quarantine')
    expect(classifyContact({
      glofox_membership_status: 'credit_member', last_attended_at: null, last_booked_at: null,
    })).toBe('quarantine')
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
  it('counts active base, at-risk, high-risk, quarantine + paused, split by segment', () => {
    const contacts = [
      healthy(),
      healthy({ id: 'c-quiet', last_attended_at: daysAgo(20), total_attended_7d: 0, total_attended_30d: 2 }),
      healthy({ id: 'c-bad', last_attended_at: daysAgo(35), total_attended_7d: 0, total_attended_30d: 1, total_noshow_30d: 4 }),
      healthy({ id: 'c-credit', glofox_membership_status: 'credit_member' }),
      { id: 'c-quar1', glofox_membership_status: 'member', last_attended_at: null, last_booked_at: null },
      { id: 'c-quar2', glofox_membership_status: 'credit_member', last_attended_at: null, last_booked_at: null },
      healthy({ id: 'c-paused', glofox_membership_state: 'paused', last_attended_at: daysAgo(20), total_attended_7d: 0, total_attended_30d: 2 }),
      { id: 'c-trial', glofox_membership_status: 'trial' },
    ]
    const s = radarSummary(contacts, NOW)
    expect(s.activeBase).toBe(4)   // healthy, c-quiet, c-bad, c-credit
    expect(s.atRisk).toBe(2)       // c-quiet, c-bad
    expect(s.highRisk).toBe(1)     // c-bad
    expect(s.quarantine).toBe(2)
    expect(s.paused).toBe(1)       // c-paused excluded despite tripping signals
    expect(s.bySegment.member).toEqual({ activeBase: 3, atRisk: 2, highRisk: 1 })
    expect(s.bySegment.credit).toEqual({ activeBase: 1, atRisk: 0, highRisk: 0 })
  })
})

describe('paused / off-radar membership states', () => {
  it('classifies a paused / cancelled / expired membership as paused', () => {
    expect(classifyContact(healthy({ glofox_membership_state: 'paused' }))).toBe('paused')
    expect(classifyContact(healthy({ glofox_membership_state: 'cancelled' }))).toBe('paused')
    expect(classifyContact(healthy({ glofox_membership_state: 'expired' }))).toBe('paused')
  })
  it('still scores active, unknown and missing states', () => {
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
  it('keeps paused members out of buildRadar', () => {
    const contacts = [
      healthy({ id: 'c-bad', last_attended_at: daysAgo(35), total_attended_7d: 0, total_attended_30d: 1, total_noshow_30d: 4 }),
      healthy({ id: 'c-paused', glofox_membership_state: 'paused', last_attended_at: daysAgo(35), total_attended_7d: 0, total_attended_30d: 1, total_noshow_30d: 4 }),
    ]
    expect(buildRadar(contacts, NOW).map((r) => r.contactId)).toEqual(['c-bad'])
  })
})

describe('segment', () => {
  it('tags scored members member vs credit', () => {
    const m = scoreMember(healthy({ last_attended_at: daysAgo(20), total_attended_7d: 0, total_attended_30d: 2 }), NOW)
    expect(m.segment).toBe('member')
    const c = scoreMember(healthy({
      glofox_membership_status: 'credit_member',
      last_attended_at: daysAgo(20), total_attended_7d: 0, total_attended_30d: 2,
    }), NOW)
    expect(c.segment).toBe('credit')
  })
})

describe('MEMBER_STATUSES', () => {
  it('is the paying-member set', () => {
    expect(MEMBER_STATUSES).toEqual(['member', 'credit_member'])
  })
})
