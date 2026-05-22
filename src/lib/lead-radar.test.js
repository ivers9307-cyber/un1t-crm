import { describe, it, expect } from 'vitest'
import {
  NON_MEMBER_STATUSES,
  classifyNonMember,
  scoreFunnelContact,
  buildFunnel,
  buildCleanup,
  leadRadarSummary,
  computeLeadConversionStats,
  computeLeadTrend,
} from './lead-radar.js'

// Fixed clock so every age computation is deterministic.
const NOW = new Date('2026-05-21T12:00:00.000Z').getTime()
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString()

// Minimal non-member contact row.
function contact(over = {}) {
  return {
    id: over.id || 'c1',
    name: over.name || 'Test Contact',
    glofox_membership_status: 'lead',
    last_attended_at: null,
    last_booked_at: null,
    joined_at: daysAgo(30),
    ...over,
  }
}

describe('classifyNonMember', () => {
  it('returns "out" for paying members', () => {
    expect(classifyNonMember(contact({ glofox_membership_status: 'member' }), NOW)).toBe('out')
    expect(classifyNonMember(contact({ glofox_membership_status: 'credit_member' }), NOW)).toBe('out')
  })

  it('returns "out" for a null or unrecognised status', () => {
    expect(classifyNonMember(contact({ glofox_membership_status: null }), NOW)).toBe('out')
    expect(classifyNonMember(contact({ glofox_membership_status: 'banana' }), NOW)).toBe('out')
  })

  it('routes no-sale statuses straight to "no_sale" regardless of age', () => {
    expect(classifyNonMember(
      contact({ glofox_membership_status: 'no_sale_trial', joined_at: daysAgo(5) }), NOW,
    )).toBe('no_sale')
    expect(classifyNonMember(
      contact({ glofox_membership_status: 'no_sale_tour', joined_at: daysAgo(900) }), NOW,
    )).toBe('no_sale')
  })

  it('classifies recent class activity as "attending"', () => {
    expect(classifyNonMember(
      contact({ glofox_membership_status: 'trial', last_attended_at: daysAgo(10) }), NOW,
    )).toBe('attending')
    // A booking with no attendance still counts as activity.
    expect(classifyNonMember(
      contact({ glofox_membership_status: 'lead', last_booked_at: daysAgo(30) }), NOW,
    )).toBe('attending')
  })

  it('treats activity exactly at the 90-day edge as attending', () => {
    expect(classifyNonMember(
      contact({ glofox_membership_status: 'trial', last_attended_at: daysAgo(90) }), NOW,
    )).toBe('attending')
  })

  it('classifies a recent join with no activity as "fresh"', () => {
    expect(classifyNonMember(
      contact({ glofox_membership_status: 'lead', joined_at: daysAgo(20) }), NOW,
    )).toBe('fresh')
  })

  it('falls out of "attending" once activity is older than 90 days', () => {
    // Activity 200d ago, joined 50d ago -> not attending, joined recently -> fresh.
    expect(classifyNonMember(
      contact({ glofox_membership_status: 'classpass_payg', last_attended_at: daysAgo(200), joined_at: daysAgo(50) }), NOW,
    )).toBe('fresh')
  })

  it('classifies a months-old join with no activity as "cooling"', () => {
    expect(classifyNonMember(
      contact({ glofox_membership_status: 'lead', joined_at: daysAgo(200) }), NOW,
    )).toBe('cooling')
  })

  it('classifies a join over a year old with no activity as "dormant"', () => {
    expect(classifyNonMember(
      contact({ glofox_membership_status: 'trial', joined_at: daysAgo(500) }), NOW,
    )).toBe('dormant')
  })

  it('parks a contact with no usable join date in "cooling"', () => {
    expect(classifyNonMember(
      contact({ glofox_membership_status: 'lead', joined_at: null }), NOW,
    )).toBe('cooling')
  })
})

describe('scoreFunnelContact', () => {
  it('scores an attending ClassPass contact highest (convert opportunity)', () => {
    const r = scoreFunnelContact(
      contact({ glofox_membership_status: 'classpass_payg', last_attended_at: daysAgo(5) }), NOW)
    expect(r.score).toBe(4)
    expect(r.tier).toBe('high')
    expect(r.signal.key).toBe('classpass_convert')
    expect(r.category).toBe('attending')
  })

  it('scores an attending trial below ClassPass', () => {
    const r = scoreFunnelContact(
      contact({ glofox_membership_status: 'trial', last_attended_at: daysAgo(5) }), NOW)
    expect(r.score).toBe(3)
    expect(r.tier).toBe('medium')
    expect(r.signal.key).toBe('trial_convert')
  })

  it('scores an attending lead as re-engaged', () => {
    const r = scoreFunnelContact(
      contact({ glofox_membership_status: 'lead', last_booked_at: daysAgo(5) }), NOW)
    expect(r.score).toBe(2)
    expect(r.signal.key).toBe('reengaged')
  })

  it('scores a fresh no-activity signup lowest', () => {
    const r = scoreFunnelContact(
      contact({ glofox_membership_status: 'lead', joined_at: daysAgo(10) }), NOW)
    expect(r.score).toBe(1)
    expect(r.tier).toBe('low')
    expect(r.signal.key).toBe('fresh_signup')
    expect(r.category).toBe('fresh')
  })

  it('returns null for cleanup-bucket and out-of-scope contacts', () => {
    expect(scoreFunnelContact(contact({ joined_at: daysAgo(500) }), NOW)).toBeNull()
    expect(scoreFunnelContact(contact({ glofox_membership_status: 'no_sale_trial' }), NOW)).toBeNull()
    expect(scoreFunnelContact(contact({ glofox_membership_status: 'member' }), NOW)).toBeNull()
  })
})

describe('buildFunnel', () => {
  it('returns only funnel contacts, highest score first', () => {
    const rows = buildFunnel([
      contact({ id: 'fresh', glofox_membership_status: 'lead', joined_at: daysAgo(10) }),
      contact({ id: 'cp', glofox_membership_status: 'classpass_payg', last_attended_at: daysAgo(3) }),
      contact({ id: 'trial', glofox_membership_status: 'trial', last_attended_at: daysAgo(3) }),
      contact({ id: 'dormant', glofox_membership_status: 'trial', joined_at: daysAgo(800) }),
    ], NOW)
    expect(rows.map(r => r.contactId)).toEqual(['cp', 'trial', 'fresh'])
  })

  it('breaks score ties by most-recent activity', () => {
    const rows = buildFunnel([
      contact({ id: 'older', glofox_membership_status: 'classpass_payg', last_attended_at: daysAgo(40) }),
      contact({ id: 'newer', glofox_membership_status: 'classpass_payg', last_attended_at: daysAgo(2) }),
    ], NOW)
    expect(rows.map(r => r.contactId)).toEqual(['newer', 'older'])
  })
})

describe('buildCleanup', () => {
  it('returns only cleanup contacts, longest-dormant first', () => {
    const rows = buildCleanup([
      contact({ id: 'recent', glofox_membership_status: 'lead', joined_at: daysAgo(200) }),
      contact({ id: 'ancient', glofox_membership_status: 'trial', joined_at: daysAgo(1200) }),
      contact({ id: 'attending', glofox_membership_status: 'trial', last_attended_at: daysAgo(5) }),
      contact({ id: 'nosale', glofox_membership_status: 'no_sale_trial', joined_at: daysAgo(600) }),
    ], NOW)
    expect(rows.map(r => r.contactId)).toEqual(['ancient', 'nosale', 'recent'])
    expect(rows.find(r => r.contactId === 'ancient').bucket).toBe('dormant')
    expect(rows.find(r => r.contactId === 'recent').bucket).toBe('cooling')
    expect(rows.find(r => r.contactId === 'nosale').bucket).toBe('no_sale')
  })

  it('attaches a human-readable reason to every cleanup row', () => {
    const rows = buildCleanup([contact({ joined_at: daysAgo(800) })], NOW)
    expect(rows[0].reason).toMatch(/over a year/)
  })
})

describe('leadRadarSummary', () => {
  it('counts the funnel and cleanup buckets', () => {
    const s = leadRadarSummary([
      contact({ glofox_membership_status: 'classpass_payg', last_attended_at: daysAgo(3) }),
      contact({ glofox_membership_status: 'trial', last_attended_at: daysAgo(3) }),
      contact({ glofox_membership_status: 'lead', joined_at: daysAgo(15) }),
      contact({ glofox_membership_status: 'lead', joined_at: daysAgo(200) }),
      contact({ glofox_membership_status: 'trial', joined_at: daysAgo(900) }),
      contact({ glofox_membership_status: 'no_sale_tour' }),
      contact({ glofox_membership_status: 'member' }),
    ], NOW)
    expect(s.funnelTotal).toBe(3)
    expect(s.funnel).toEqual({ attending: 2, fresh: 1 })
    expect(s.cleanupTotal).toBe(3)
    expect(s.cleanup).toEqual({ cooling: 1, dormant: 1, no_sale: 1 })
  })

  it('ignores out-of-scope (member) contacts in both totals', () => {
    const s = leadRadarSummary([
      contact({ glofox_membership_status: 'member' }),
      contact({ glofox_membership_status: 'credit_member' }),
    ], NOW)
    expect(s.funnelTotal).toBe(0)
    expect(s.cleanupTotal).toBe(0)
  })
})

describe('NON_MEMBER_STATUSES', () => {
  it('is frozen and excludes the paying-member statuses', () => {
    expect(Object.isFrozen(NON_MEMBER_STATUSES)).toBe(true)
    expect(NON_MEMBER_STATUSES).not.toContain('member')
    expect(NON_MEMBER_STATUSES).not.toContain('credit_member')
  })
})

describe('LEAD-OUTCOMES.1 — computeLeadConversionStats', () => {
  const action = (contactId, type, daysAgoN) => ({
    contact_id: contactId, action: type, created_at: daysAgo(daysAgoN),
  })

  it('counts a contacted lead who attended afterwards as progressed', () => {
    const r = computeLeadConversionStats(
      [contact({ id: 'L1', last_attended_at: daysAgo(10) })],
      [action('L1', 'contacted', 30)], NOW)
    expect(r).toEqual({ contacted: 1, progressed: 1, progressionRate: 1 })
  })

  it('counts a booking (not just attendance) after the contact as progressed', () => {
    const r = computeLeadConversionStats(
      [contact({ id: 'L1', last_booked_at: daysAgo(8) })],
      [action('L1', 'contacted', 30)], NOW)
    expect(r.progressed).toBe(1)
  })

  it('does not count a lead with no activity after the contact', () => {
    const r = computeLeadConversionStats(
      [contact({ id: 'L1', last_attended_at: daysAgo(45), last_booked_at: null })],
      [action('L1', 'contacted', 30)], NOW)
    expect(r).toEqual({ contacted: 1, progressed: 0, progressionRate: 0 })
  })

  it('computes the rate across a batch', () => {
    const contacts = [
      contact({ id: 'a', last_booked_at: daysAgo(5) }),    // progressed
      contact({ id: 'b', last_attended_at: daysAgo(50) }), // activity predates contact
      contact({ id: 'c' }),                                 // no activity at all
      contact({ id: 'd', last_attended_at: daysAgo(2) }),  // progressed
    ]
    const actions = ['a', 'b', 'c', 'd'].map((id) => action(id, 'contacted', 30))
    const r = computeLeadConversionStats(contacts, actions, NOW)
    expect(r.contacted).toBe(4)
    expect(r.progressed).toBe(2)
    expect(r.progressionRate).toBe(0.5)
  })

  it('excludes contacts too recent to judge (grace period)', () => {
    expect(computeLeadConversionStats(
      [contact({ id: 'L1', last_attended_at: daysAgo(1) })],
      [action('L1', 'contacted', 2)], NOW)).toEqual({ contacted: 0, progressed: 0, progressionRate: 0 })
  })

  it('excludes contacts older than the 90-day window', () => {
    expect(computeLeadConversionStats(
      [contact({ id: 'L1', last_attended_at: daysAgo(10) })],
      [action('L1', 'contacted', 120)], NOW).contacted).toBe(0)
  })

  it('ignores non-contact actions (snooze, cleanup triage)', () => {
    const r = computeLeadConversionStats(
      [contact({ id: 'L1', last_attended_at: daysAgo(5) })],
      [action('L1', 'snoozed', 30), action('L1', 'cleanup_archive', 30)], NOW)
    expect(r.contacted).toBe(0)
  })

  it('returns zeroes for empty / null input', () => {
    expect(computeLeadConversionStats([], [], NOW)).toEqual({ contacted: 0, progressed: 0, progressionRate: 0 })
    expect(computeLeadConversionStats(null, null, NOW)).toEqual({ contacted: 0, progressed: 0, progressionRate: 0 })
  })
})

describe('LEAD-TREND.1 — computeLeadTrend', () => {
  const summary = {
    funnelTotal: 463, funnel: { attending: 203, fresh: 260 },
    cleanupTotal: 6500,
  }

  it('diffs the live summary against the latest snapshot', () => {
    const snapshot = {
      captured_at: '2026-05-14T06:30:00.000Z',
      funnel_total: 450, attending: 198, fresh: 252, cleanup_total: 6600,
    }
    const t = computeLeadTrend(summary, snapshot)
    expect(t.since).toBe('2026-05-14T06:30:00.000Z')
    expect(t.deltas.funnelTotal).toBe(13)
    expect(t.deltas.attending).toBe(5)
    expect(t.deltas.fresh).toBe(8)
    expect(t.deltas.cleanupTotal).toBe(-100)
  })

  it('returns null when there is no snapshot to compare against', () => {
    expect(computeLeadTrend(summary, null)).toBeNull()
    expect(computeLeadTrend(null, {})).toBeNull()
  })

  it('treats missing snapshot columns as zero', () => {
    const t = computeLeadTrend(summary, { captured_at: '2026-05-14T06:30:00.000Z' })
    expect(t.deltas.funnelTotal).toBe(463)
    expect(t.deltas.attending).toBe(203)
  })
})
