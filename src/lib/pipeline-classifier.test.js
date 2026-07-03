// FUNNEL.1 — acquisition-funnel classifier tests. Fixtures are named
// people so failures read like a story (repo convention from PIPELINE5).
import { describe, it, expect } from 'vitest'
import {
  classifyContact,
  countAttendedBookings,
  nextBookedClass,
  PIPELINE_THRESHOLDS,
} from './pipeline-classifier.js'

const NOW = new Date('2026-07-02T12:00:00Z').getTime()
const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString()
const unixDaysFromNow = (n) => Math.floor((NOW + n * 24 * 60 * 60 * 1000) / 1000)

// recent_bookings entries mirror the Glofox sync shape (GLOFOX2.1.18).
const attendedBooking = (nDaysAgo) => ({
  status: 'BOOKED', attended: true, time_start: unixDaysFromNow(-nDaysAgo),
})
const futureBooking = (nDaysAhead) => ({
  status: 'BOOKED', attended: false, time_start: unixDaysFromNow(nDaysAhead),
})

describe('countAttendedBookings', () => {
  it('counts only attended=true entries', () => {
    expect(countAttendedBookings([attendedBooking(3), futureBooking(2), attendedBooking(10)])).toBe(2)
  })
  it('is 0 for null / non-array', () => {
    expect(countAttendedBookings(null)).toBe(0)
    expect(countAttendedBookings('nope')).toBe(0)
  })
})

describe('nextBookedClass', () => {
  it('returns the SOONEST future BOOKED class as ISO', () => {
    const iso = nextBookedClass([futureBooking(5), futureBooking(2), attendedBooking(1)], NOW)
    expect(iso).toBe(new Date(unixDaysFromNow(2) * 1000).toISOString())
  })
  it('ignores past bookings and cancelled statuses', () => {
    expect(nextBookedClass([attendedBooking(1), { status: 'CANCELLED', time_start: unixDaysFromNow(3) }], NOW)).toBeNull()
  })
  it('is null for empty/missing', () => {
    expect(nextBookedClass(null, NOW)).toBeNull()
  })
})

describe('classifyContact — funnel columns', () => {
  it('Nora: joined last week, no classes → new_lead', () => {
    expect(classifyContact({
      glofox_membership_status: 'lead', joined_at: daysAgo(7), recent_bookings: [],
    }, NOW)).toBe('new_lead')
  })
  it('Nora with a class BOOKED but not attended stays new_lead (badge carries the signal)', () => {
    expect(classifyContact({
      glofox_membership_status: 'lead', joined_at: daysAgo(7),
      recent_bookings: [futureBooking(2)],
    }, NOW)).toBe('new_lead')
  })
  it('Fiona: 1 class attended recently → first_class', () => {
    expect(classifyContact({
      glofox_membership_status: 'trial', joined_at: daysAgo(20),
      last_attended_at: daysAgo(5), recent_bookings: [attendedBooking(5)],
    }, NOW)).toBe('first_class')
  })
  it('Sean: 2 attended → second_class', () => {
    expect(classifyContact({
      glofox_membership_status: 'trial', joined_at: daysAgo(20),
      last_attended_at: daysAgo(3), recent_bookings: [attendedBooking(3), attendedBooking(9)],
    }, NOW)).toBe('second_class')
  })
  it('Aoife: 3 attended, no membership → trial_done (decision point)', () => {
    expect(classifyContact({
      glofox_membership_status: 'trial', joined_at: daysAgo(30),
      last_attended_at: daysAgo(2),
      recent_bookings: [attendedBooking(2), attendedBooking(6), attendedBooking(12)],
    }, NOW)).toBe('trial_done')
  })
  it('4+ attended without converting folds into trial_done', () => {
    expect(classifyContact({
      glofox_membership_status: 'no_sale_trial', joined_at: daysAgo(40),
      last_attended_at: daysAgo(4),
      recent_bookings: [attendedBooking(4), attendedBooking(8), attendedBooking(15), attendedBooking(22)],
    }, NOW)).toBe('trial_done')
  })
})

describe('classifyContact — funnel exits', () => {
  it('lead joined 70d ago with no classes ages out → dormant (60d window on joined_at, NOT lead_created_at)', () => {
    expect(classifyContact({
      glofox_membership_status: 'lead', joined_at: daysAgo(70), recent_bookings: [],
    }, NOW)).toBe('dormant')
  })
  it('mid-funnel lead does NOT vanish at day 60 — window keys on activity, not joined_at', () => {
    expect(classifyContact({
      glofox_membership_status: 'trial', joined_at: daysAgo(65),
      last_attended_at: daysAgo(10), recent_bookings: [attendedBooking(10), attendedBooking(20)],
    }, NOW)).toBe('second_class')
  })
  it('funnel lead gone quiet 61+d since last class → dormant', () => {
    expect(classifyContact({
      glofox_membership_status: 'trial', joined_at: daysAgo(100),
      last_attended_at: daysAgo(61), recent_bookings: [attendedBooking(61)],
    }, NOW)).toBe('dormant')
  })
  it('last_attended_at set but recent_bookings pruned still counts as attended once', () => {
    expect(classifyContact({
      glofox_membership_status: 'trial', joined_at: daysAgo(20),
      last_attended_at: daysAgo(5), recent_bookings: [],
    }, NOW)).toBe('first_class')
  })
  it('FUTURE last_attended_at (check-in flagged before class start) counts as active, not dormant', () => {
    expect(classifyContact({
      glofox_membership_status: 'trial', joined_at: daysAgo(20),
      last_attended_at: new Date(NOW + 60 * 60 * 1000).toISOString(), // 1h ahead
      recent_bookings: [attendedBooking(0)],
    }, NOW)).toBe('first_class')
  })
  it('lead joined at EXACTLY the new-lead window boundary is still new_lead (pins <= semantics)', () => {
    expect(classifyContact({
      glofox_membership_status: 'lead',
      joined_at: daysAgo(PIPELINE_THRESHOLDS.NEW_LEAD_WINDOW_DAYS),
      recent_bookings: [],
    }, NOW)).toBe('new_lead')
  })
})

describe('classifyContact — converted & members', () => {
  it('converted 10d ago → converted, regardless of class count (early converter after 1 class)', () => {
    expect(classifyContact({
      glofox_membership_status: 'member', converted_at: daysAgo(10),
      joined_at: daysAgo(15), recent_bookings: [attendedBooking(12)],
    }, NOW)).toBe('converted')
  })
  it('converted 61d ago rolls off the board → member', () => {
    expect(classifyContact({
      glofox_membership_status: 'member', converted_at: daysAgo(61), joined_at: daysAgo(200),
    }, NOW)).toBe('member')
  })
  it('pre-existing member with no converted_at → member', () => {
    expect(classifyContact({
      glofox_membership_status: 'credit_member', joined_at: daysAgo(400),
    }, NOW)).toBe('member')
  })
})

describe('classifyContact — exclusions', () => {
  it('ClassPass PAYG is NEVER in the funnel → classpass', () => {
    expect(classifyContact({
      glofox_membership_status: 'classpass_payg', joined_at: daysAgo(5),
      last_attended_at: daysAgo(2), recent_bookings: [attendedBooking(2)],
    }, NOW)).toBe('classpass')
  })
  it('ex_member → dormant (winback, not a funnel lead)', () => {
    expect(classifyContact({
      glofox_membership_status: 'ex_member', joined_at: daysAgo(300),
    }, NOW)).toBe('dormant')
  })
  it('null/garbage input → dormant', () => {
    expect(classifyContact(null, NOW)).toBe('dormant')
  })
})

describe('classifyContact — pack customers (FUNNEL.3)', () => {
  // Wendy Bertrand's case (operator-reported 2026-07-03): Glofox status
  // stuck on cold/lead, but an ACTIVE credit pack with more credits than
  // any trial we sell — a paying customer, not a funnel prospect.
  it('Wendy: cold status + 16-credit active pack + attending → member (off funnel)', () => {
    expect(classifyContact({
      glofox_membership_status: 'cold', joined_at: daysAgo(220),
      last_attended_at: daysAgo(1), trial_credits_remaining: 16,
      recent_bookings: [attendedBooking(1), attendedBooking(2), attendedBooking(4), attendedBooking(7)],
    }, NOW)).toBe('member')
  })
  it('lead status + big pack + attending → member', () => {
    expect(classifyContact({
      glofox_membership_status: 'lead', joined_at: daysAgo(10),
      last_attended_at: daysAgo(8), trial_credits_remaining: 92,
      recent_bookings: [attendedBooking(8)],
    }, NOW)).toBe('member')
  })
  it('pack holder gone quiet 60d+ is a WINBACK target, not a member → dormant', () => {
    expect(classifyContact({
      glofox_membership_status: 'cold', joined_at: daysAgo(300),
      last_attended_at: daysAgo(120), trial_credits_remaining: 10,
      recent_bookings: [attendedBooking(120)],
    }, NOW)).toBe('dormant')
  })
  it('big-pack buyer who has never attended follows normal funnel rules → new_lead', () => {
    expect(classifyContact({
      glofox_membership_status: 'lead', joined_at: daysAgo(10),
      trial_credits_remaining: 92, recent_bookings: [],
    }, NOW)).toBe('new_lead')
  })
  it('pack running low (≤3 credits) re-enters the funnel at the decision point', () => {
    expect(classifyContact({
      glofox_membership_status: 'cold', joined_at: daysAgo(220),
      last_attended_at: daysAgo(1), trial_credits_remaining: 2,
      recent_bookings: [attendedBooking(1), attendedBooking(2), attendedBooking(4)],
    }, NOW)).toBe('trial_done')
  })
  it('a genuine 3-credit trial is NOT a pack customer (also the mig-001 schema default)', () => {
    expect(classifyContact({
      glofox_membership_status: 'trial', joined_at: daysAgo(5),
      last_attended_at: daysAgo(2), trial_credits_remaining: 3,
      recent_bookings: [attendedBooking(2)],
    }, NOW)).toBe('first_class')
  })
  it('null credits → normal funnel rules', () => {
    expect(classifyContact({
      glofox_membership_status: 'lead', joined_at: daysAgo(5),
      trial_credits_remaining: null, recent_bookings: [],
    }, NOW)).toBe('new_lead')
  })
  it('classpass_payg with credits stays classpass (distinct motion wins)', () => {
    expect(classifyContact({
      glofox_membership_status: 'classpass_payg', trial_credits_remaining: 20,
    }, NOW)).toBe('classpass')
  })
})

describe('idempotency', () => {
  it('same input twice → same output, and the input is never mutated', () => {
    const c = Object.freeze({
      glofox_membership_status: 'trial', joined_at: daysAgo(10),
      last_attended_at: daysAgo(3),
      recent_bookings: Object.freeze([Object.freeze(attendedBooking(3))]),
    })
    // Frozen fixture: any mutation attempt throws in strict mode (ESM),
    // so passing = pure function that leaves its input alone.
    expect(classifyContact(c, NOW)).toBe(classifyContact(c, NOW))
  })
})
