import { describe, it, expect } from 'vitest'
import {
  mapGlofoxMember,
  mapMembershipStatus,
  previewMemberSync,
  parseGlofoxDate,
  parseGlofoxJoinedAt,
  normalizePhone,
  mapGlofoxSource,
  pipelineStageSlugForStatus,
  targetDealStageForSync,
  isClassPackMembership,
  detectCreditMember,
  computeBookingAggregates,
  mapGlofoxInteraction,
  computeCreditsRemaining,
  detectTrialTransitionTags,
  extractMembershipPlan,
} from './glofox-sync.js'

// Helper: build a Plan A ctx for tests. Real call site fetches via
// /2.0/credits + /2.0/memberships. Tests inline-construct the same
// shape to exercise mapping logic without hitting the API.
function makeCtx({ credits = [], memberships = [] } = {}) {
  const cache = new Map()
  for (const m of memberships) cache.set(m._id, m)
  return { credits, memberships: cache }
}

const CLASS_PACK_MEMBERSHIP = {
  _id: '6512ae6b179d3834bb0b7f78',
  name: 'Class Packs',
  trial: false,
  plans: [
    { code: 1, type: 'num_classes', price: 25 },
    { code: 2, type: 'num_classes', price: 120 },
    { code: 3, type: 'num_classes', price: 210 },
  ],
}

const TRIAL_MEMBERSHIP = {
  _id: '620bdab4df0f8054814cd7be',
  name: '1) The UN1T Trial',
  trial: true,
  plans: [{ code: 999, type: 'num_classes', price: 0 }],
}

const SUBSCRIPTION_MEMBERSHIP = {
  _id: 'sub_membership_1',
  name: 'Unlimited Monthly',
  trial: false,
  plans: [{ code: 100, type: 'time', price: 99 }],
}

describe('mapGlofoxMember', () => {
  it('returns null for a non-object', () => {
    expect(mapGlofoxMember(null)).toBeNull()
    expect(mapGlofoxMember('string')).toBeNull()
  })

  it('returns null when no _id is present', () => {
    expect(mapGlofoxMember({ email: 'me@x.com' })).toBeNull()
  })

  it('extracts the canonical fields with _id', () => {
    const out = mapGlofoxMember({
      _id: 'abc123',
      email: 'A@B.COM',
      first_name: 'Alice',
      last_name: 'Smith',
      phone: '+353871234567',
    })
    expect(out.glofox_member_id).toBe('abc123')
    expect(out.email).toBe('a@b.com') // lowercased
    expect(out.first_name).toBe('Alice')
    expect(out.last_name).toBe('Smith')
    expect(out.phone).toBe('+353871234567')
    expect(out.name).toBe('Alice Smith')
  })

  it('falls back through id paths', () => {
    expect(mapGlofoxMember({ id: 'x' })?.glofox_member_id).toBe('x')
    expect(mapGlofoxMember({ member_id: 'y' })?.glofox_member_id).toBe('y')
  })

  it('splits a full name when first/last are absent', () => {
    const out = mapGlofoxMember({ _id: 'x', name: 'Alice Smith' })
    expect(out.first_name).toBe('Alice')
    expect(out.last_name).toBe('Smith')
  })

  it('handles single-word names', () => {
    const out = mapGlofoxMember({ _id: 'x', name: 'Cher' })
    expect(out.first_name).toBe('Cher')
    expect(out.last_name).toBeNull()
  })

  it('falls back to email then "Glofox member" for the name column', () => {
    expect(mapGlofoxMember({ _id: 'x', email: 'me@x.com' }).name).toBe('me@x.com')
    expect(mapGlofoxMember({ _id: 'x' }).name).toBe('Glofox member')
  })

  it('coerces _id to a string', () => {
    expect(mapGlofoxMember({ _id: 12345 }).glofox_member_id).toBe('12345')
  })
})

describe('mapMembershipStatus (GLOFOX2.1.5 canonical enum)', () => {
  // The portal's "Client Status" picker shows: Cold, Tour,
  // No Sale (Tour), Trial, No Sale (Trial), Member. We mirror those
  // in lowercased canonical form + add ex_member (synthesised when
  // lead_status=MEMBER + active=false). Anything else → 'lead'.
  it('returns lead when no membership info present', () => {
    expect(mapMembershipStatus({})).toBe('lead')
    expect(mapMembershipStatus(null)).toBe('lead')
  })

  it('maps each portal-visible Client Status to its canonical', () => {
    expect(mapMembershipStatus({ lead_status: 'COLD' })).toBe('cold')
    expect(mapMembershipStatus({ lead_status: 'TOUR' })).toBe('tour')
    expect(mapMembershipStatus({ lead_status: 'NO_SALE_TOUR' })).toBe('no_sale_tour')
    expect(mapMembershipStatus({ lead_status: 'TRIAL' })).toBe('trial')
    expect(mapMembershipStatus({ lead_status: 'NO_SALE_TRIAL' })).toBe('no_sale_trial')
    expect(mapMembershipStatus({ lead_status: 'MEMBER' })).toBe('member')
    expect(mapMembershipStatus({ lead_status: 'LEAD' })).toBe('lead')
  })

  it('synthesises ex_member from MEMBER + active:false (lapsed)', () => {
    // Glofox doesn't have an "ex member" lead_status — a lapsed
    // member shows as MEMBER with the top-level active boolean
    // flipped to false. We collapse the pair into one canonical.
    expect(mapMembershipStatus({ lead_status: 'MEMBER', active: false })).toBe('ex_member')
  })

  it('still returns member when MEMBER + active:true', () => {
    expect(mapMembershipStatus({ lead_status: 'MEMBER', active: true })).toBe('member')
  })

  it('does NOT synthesise ex_member from active:false alone', () => {
    // active:false on a non-MEMBER lead_status (or none) is just
    // a quirk of the payload — don't promote it to ex_member.
    expect(mapMembershipStatus({ lead_status: 'TRIAL', active: false })).toBe('trial')
    expect(mapMembershipStatus({ active: false })).toBe('lead')
  })

  it('accepts the portal-label form "No Sale (Tour)"', () => {
    expect(mapMembershipStatus({ lead_status: 'No Sale (Tour)' })).toBe('no_sale_tour')
    expect(mapMembershipStatus({ lead_status: 'No Sale (Trial)' })).toBe('no_sale_trial')
  })

  it('accepts smushed and dashed forms', () => {
    expect(mapMembershipStatus({ lead_status: 'NoSale_Tour' })).toBe('no_sale_tour')
    expect(mapMembershipStatus({ lead_status: 'NO-SALE-TRIAL' })).toBe('no_sale_trial')
  })

  it('reads nested leads.status (Glofox secondary path)', () => {
    expect(mapMembershipStatus({ leads: { status: 'TRIAL' } })).toBe('trial')
  })

  it('lowercases + trims', () => {
    expect(mapMembershipStatus({ lead_status: '  TRIAL  ' })).toBe('trial')
  })

  it('returns lead for an unrecognised lead_status', () => {
    // Defensive default: contact still surfaces in the pipeline at
    // new_lead rather than vanishing because Glofox shipped a new
    // status we haven't mapped yet.
    expect(mapMembershipStatus({ lead_status: 'BRAND_NEW_GLOFOX_STATUS' })).toBe('lead')
  })

  // GLOFOX2.1.6 — ClassPass PAYG detection.
  //
  // ClassPass-originated PAYG users default to lead_status=LEAD in
  // Glofox (it has no dedicated status for them). We synthesise
  // 'classpass_payg' from the deeper payload signals so they land
  // in conversion_ready instead of new_lead.
  it('detects ClassPass PAYG (active) → classpass_payg', () => {
    expect(mapMembershipStatus({
      origin: 'classpass',
      membership: { type: 'payg' },
      lead_status: 'LEAD',
      active: true,
    })).toBe('classpass_payg')
  })

  it('collapses inactive ClassPass PAYG into ex_member', () => {
    // Operationally equivalent to a lapsed subscription member:
    // they were paying customers, now they're not. Same lost_member
    // surface for win-back.
    expect(mapMembershipStatus({
      origin: 'classpass',
      membership: { type: 'payg' },
      lead_status: 'LEAD',
      active: false,
    })).toBe('ex_member')
  })

  it('ClassPass detection takes precedence over lead_status=LEAD', () => {
    // Without the synthesis they'd fall through to 'lead' → new_lead.
    const out = mapMembershipStatus({
      origin: 'classpass',
      membership: { type: 'payg' },
      lead_status: 'LEAD',
      active: true,
    })
    expect(out).not.toBe('lead')
    expect(out).toBe('classpass_payg')
  })

  it('does NOT trigger ClassPass detection without origin=classpass', () => {
    expect(mapMembershipStatus({
      membership: { type: 'payg' },
      lead_status: 'LEAD',
      active: true,
    })).toBe('lead')
  })

  it('does NOT trigger ClassPass detection without membership.type=payg', () => {
    // A ClassPass-originated user who took out a real subscription
    // should map by lead_status, not by origin.
    expect(mapMembershipStatus({
      origin: 'classpass',
      membership: { type: 'subscription' },
      lead_status: 'MEMBER',
      active: true,
    })).toBe('member')
  })

  it('ClassPass detection is case-insensitive', () => {
    expect(mapMembershipStatus({
      origin: 'ClassPass',
      membership: { type: 'PAYG' },
      lead_status: 'LEAD',
      active: true,
    })).toBe('classpass_payg')
  })

  // GLOFOX2.1.11 — Plan A credit_member detection via /2.0/credits +
  // parent Membership lookup. Replaces the broken GLOFOX2.1.7 attempt
  // and the GLOFOX2.1.9 revert. The detection requires a `ctx`
  // containing credits + memberships fetched at sync time.
  it('without ctx, MEMBER falls back to standard mapping (no credit_member detection)', () => {
    // Legacy callers / tests that don't supply ctx still work.
    expect(mapMembershipStatus({
      lead_status: 'MEMBER',
      active: true,
    })).toBe('member')
  })

  it('with ctx — MEMBER + active Class Pack credits → credit_member', () => {
    const ctx = makeCtx({
      credits: [{ active: true, num_sessions: 10, membership_id: CLASS_PACK_MEMBERSHIP._id, model: 'programs' }],
      memberships: [CLASS_PACK_MEMBERSHIP],
    })
    expect(mapMembershipStatus({
      lead_status: 'MEMBER',
      active: true,
    }, ctx)).toBe('credit_member')
  })

  it('with ctx — MEMBER + active credits but parent is subscription → member', () => {
    // A subscription member with 'time_classes' or 'time' plans
    // should NOT be classified as credit_member.
    const ctx = makeCtx({
      credits: [{ active: true, num_sessions: 8, membership_id: SUBSCRIPTION_MEMBERSHIP._id }],
      memberships: [SUBSCRIPTION_MEMBERSHIP],
    })
    expect(mapMembershipStatus({
      lead_status: 'MEMBER',
      active: true,
    }, ctx)).toBe('member')
  })

  it('with ctx — TRIAL + active credits from trial pack → trial (NOT credit_member)', () => {
    // Roisin: TRIAL lead_status with the trial num_classes pack.
    // lead_status discriminator excludes her from credit_member.
    const ctx = makeCtx({
      credits: [{ active: true, num_sessions: 3, membership_id: TRIAL_MEMBERSHIP._id }],
      memberships: [TRIAL_MEMBERSHIP],
    })
    expect(mapMembershipStatus({
      lead_status: 'TRIAL',
      active: true,
    }, ctx)).toBe('trial')
  })

  it('with ctx — MEMBER but no active credits → member (not credit_member)', () => {
    // A subscription member with no current credit pack (e.g.,
    // unlimited 'time' subscription, or no /credits result) maps to
    // plain member.
    const ctx = makeCtx({ credits: [], memberships: [] })
    expect(mapMembershipStatus({
      lead_status: 'MEMBER',
      active: true,
    }, ctx)).toBe('member')
  })

  it('with ctx — MEMBER + INACTIVE credit packs only → member (not credit_member)', () => {
    // Past credit packs that have been used up (active:false) don't
    // qualify — only currently-active packs.
    const ctx = makeCtx({
      credits: [{ active: false, num_sessions: 10, membership_id: CLASS_PACK_MEMBERSHIP._id }],
      memberships: [CLASS_PACK_MEMBERSHIP],
    })
    expect(mapMembershipStatus({
      lead_status: 'MEMBER',
      active: true,
    }, ctx)).toBe('member')
  })

  it('with ctx — MEMBER + active=false collapses to ex_member regardless of credits', () => {
    // A lapsed Member who happened to have a credit pack still goes
    // to ex_member (the higher-priority synthesis runs first when
    // member.active=false).
    const ctx = makeCtx({
      credits: [{ active: true, num_sessions: 10, membership_id: CLASS_PACK_MEMBERSHIP._id }],
      memberships: [CLASS_PACK_MEMBERSHIP],
    })
    // active=false → detectCreditMember returns false → falls through
    // → standard path picks up MEMBER+active:false → ex_member.
    expect(mapMembershipStatus({
      lead_status: 'MEMBER',
      active: false,
    }, ctx)).toBe('ex_member')
  })

  it('with ctx — MEMBER + mixed pack memberships (one subscription) → member', () => {
    // Subscription member who ALSO bought a one-off pack on top.
    // EVERY-not-ANY rule means they\'re still primarily a member.
    const ctx = makeCtx({
      credits: [
        { active: true, num_sessions: 10, membership_id: CLASS_PACK_MEMBERSHIP._id },
        { active: true, num_sessions: 8, membership_id: SUBSCRIPTION_MEMBERSHIP._id },
      ],
      memberships: [CLASS_PACK_MEMBERSHIP, SUBSCRIPTION_MEMBERSHIP],
    })
    expect(mapMembershipStatus({
      lead_status: 'MEMBER',
      active: true,
    }, ctx)).toBe('member')
  })
})

// GLOFOX2.1.11 — pure helpers used by Plan A.
describe('isClassPackMembership', () => {
  it('returns true for a Class Pack membership (all plans num_classes, trial false)', () => {
    expect(isClassPackMembership(CLASS_PACK_MEMBERSHIP)).toBe(true)
  })

  it('returns false for a trial membership even though plans are num_classes', () => {
    expect(isClassPackMembership(TRIAL_MEMBERSHIP)).toBe(false)
  })

  it('returns false for a subscription membership (plans type=time)', () => {
    expect(isClassPackMembership(SUBSCRIPTION_MEMBERSHIP)).toBe(false)
  })

  it('returns false when plans is missing or empty', () => {
    expect(isClassPackMembership({ trial: false })).toBe(false)
    expect(isClassPackMembership({ trial: false, plans: [] })).toBe(false)
  })

  it('returns false when ANY plan is not num_classes (mixed plan types)', () => {
    expect(isClassPackMembership({
      trial: false,
      plans: [
        { type: 'num_classes' },
        { type: 'time_classes' }, // subscription with credits
      ],
    })).toBe(false)
  })

  it('is case-insensitive on plan.type', () => {
    expect(isClassPackMembership({
      trial: false,
      plans: [{ type: 'NUM_CLASSES' }],
    })).toBe(true)
  })

  it('returns false for null / non-object input', () => {
    expect(isClassPackMembership(null)).toBe(false)
    expect(isClassPackMembership('Class Packs')).toBe(false)
  })
})

// GLOFOX2.1.14 — engagement aggregates from booking history.
describe('computeBookingAggregates', () => {
  // Fix "now" for deterministic windows. 2026-05-11 12:00:00 UTC.
  const NOW = new Date('2026-05-11T12:00:00Z').getTime()
  const NOW_SEC = Math.floor(NOW / 1000)
  const sec = (isoOrSecs) => typeof isoOrSecs === 'string'
    ? Math.floor(new Date(isoOrSecs).getTime() / 1000)
    : isoOrSecs

  it('returns empty aggregates for no bookings', () => {
    expect(computeBookingAggregates([], NOW)).toEqual({
      last_booked_at: null,
      last_attended_at: null,
      total_bookings_30d: 0,
      total_attended_30d: 0,
      total_attended_7d: 0,  // PIPELINE5.3 — Hot Conversion signal
      total_noshow_30d: 0,
    })
  })

  it('returns empty aggregates for null/non-array input', () => {
    expect(computeBookingAggregates(null, NOW).total_bookings_30d).toBe(0)
    expect(computeBookingAggregates(undefined, NOW).total_bookings_30d).toBe(0)
  })

  it('captures last_booked_at as max(created)', () => {
    const out = computeBookingAggregates([
      { created: sec('2026-05-01T10:00:00Z'), status: 'BOOKED' },
      { created: sec('2026-05-08T10:00:00Z'), status: 'BOOKED' },
      { created: sec('2026-04-20T10:00:00Z'), status: 'BOOKED' },
    ], NOW)
    expect(out.last_booked_at).toBe('2026-05-08T10:00:00.000Z')
  })

  it('captures last_attended_at as max(time_start where attended)', () => {
    const out = computeBookingAggregates([
      { created: sec('2026-04-01T10:00:00Z'), time_start: sec('2026-04-02T07:00:00Z'), status: 'BOOKED', attended: true },
      { created: sec('2026-05-01T10:00:00Z'), time_start: sec('2026-05-02T07:00:00Z'), status: 'BOOKED', attended: true },
      { created: sec('2026-05-09T10:00:00Z'), time_start: sec('2026-05-10T07:00:00Z'), status: 'BOOKED', attended: false },
    ], NOW)
    expect(out.last_attended_at).toBe('2026-05-02T07:00:00.000Z')
  })

  it('counts total_bookings_30d (any status, scoped by booking creation)', () => {
    const out = computeBookingAggregates([
      { created: sec('2026-05-08T10:00:00Z'), status: 'BOOKED' },     // 3 days ago
      { created: sec('2026-05-01T10:00:00Z'), status: 'CANCELED' },   // 10 days ago
      { created: sec('2026-04-20T10:00:00Z'), status: 'BOOKED' },     // 21 days ago
      { created: sec('2026-03-01T10:00:00Z'), status: 'BOOKED' },     // 71 days ago — out of window
    ], NOW)
    expect(out.total_bookings_30d).toBe(3)
  })

  it('counts total_attended_30d (only attended + class start in window + in past)', () => {
    const out = computeBookingAggregates([
      // Attended classes within window
      { created: sec('2026-05-01T10:00:00Z'), time_start: sec('2026-05-02T07:00:00Z'), status: 'BOOKED', attended: true },
      { created: sec('2026-04-25T10:00:00Z'), time_start: sec('2026-04-26T07:00:00Z'), status: 'BOOKED', attended: true },
      // Booked but didn't attend → not counted
      { created: sec('2026-05-05T10:00:00Z'), time_start: sec('2026-05-06T07:00:00Z'), status: 'BOOKED', attended: false },
      // Future class booked (time_start in future) → not counted
      { created: sec('2026-05-10T10:00:00Z'), time_start: sec('2026-05-15T07:00:00Z'), status: 'BOOKED', attended: false },
      // Attended but outside 30d window → not counted
      { created: sec('2026-03-01T10:00:00Z'), time_start: sec('2026-03-02T07:00:00Z'), status: 'BOOKED', attended: true },
    ], NOW)
    expect(out.total_attended_30d).toBe(2)
  })

  it('counts total_attended_7d separately from 30d (PIPELINE5.3)', () => {
    // NOW is fixed at 2026-05-12 12:00 UTC. 7d cutoff = 2026-05-05 12:00.
    // 30d cutoff = 2026-04-12 12:00.
    const out = computeBookingAggregates([
      // Inside 7d window (started 2 days ago)
      { created: sec('2026-05-09T10:00:00Z'), time_start: sec('2026-05-10T07:00:00Z'), status: 'BOOKED', attended: true },
      // Inside 7d window (yesterday)
      { created: sec('2026-05-10T10:00:00Z'), time_start: sec('2026-05-11T07:00:00Z'), status: 'BOOKED', attended: true },
      // Outside 7d but inside 30d (started 12 days ago) — counts for 30d only
      { created: sec('2026-04-29T10:00:00Z'), time_start: sec('2026-04-30T07:00:00Z'), status: 'BOOKED', attended: true },
      // Outside both windows — counts for neither
      { created: sec('2026-03-01T10:00:00Z'), time_start: sec('2026-03-02T07:00:00Z'), status: 'BOOKED', attended: true },
    ], NOW)
    expect(out.total_attended_7d).toBe(2)
    expect(out.total_attended_30d).toBe(3)
  })

  it('counts total_noshow_30d (BOOKED + class in past + attended:false)', () => {
    const out = computeBookingAggregates([
      // True no-show: booked, class happened, didn't show
      { created: sec('2026-05-05T10:00:00Z'), time_start: sec('2026-05-06T07:00:00Z'), status: 'BOOKED', attended: false },
      // Cancelled in advance → NOT a no-show
      { created: sec('2026-05-04T10:00:00Z'), time_start: sec('2026-05-06T07:00:00Z'), status: 'CANCELED', attended: false },
      // Future class — they might still attend, not a no-show yet
      { created: sec('2026-05-10T10:00:00Z'), time_start: sec('2026-05-15T07:00:00Z'), status: 'BOOKED', attended: false },
      // Attended → not a no-show
      { created: sec('2026-05-01T10:00:00Z'), time_start: sec('2026-05-02T07:00:00Z'), status: 'BOOKED', attended: true },
    ], NOW)
    expect(out.total_noshow_30d).toBe(1)
  })

  it('case-insensitive on status', () => {
    const out = computeBookingAggregates([
      { created: sec('2026-05-05T10:00:00Z'), time_start: sec('2026-05-06T07:00:00Z'), status: 'booked', attended: false },
    ], NOW)
    expect(out.total_noshow_30d).toBe(1)
  })

  it('handles malformed booking entries gracefully', () => {
    const out = computeBookingAggregates([
      null,
      'not an object',
      {}, // empty
      { created: sec('2026-05-08T10:00:00Z'), status: 'BOOKED' }, // valid
    ], NOW)
    expect(out.total_bookings_30d).toBe(1)
  })

  it('uses NOW parameter for deterministic 30-day cutoff', () => {
    // Same booking data, different "now" → different aggregates.
    const fixed = NOW_SEC
    const bookings = [{ created: fixed - 10 * 86400, status: 'BOOKED' }] // 10d ago
    expect(computeBookingAggregates(bookings, NOW).total_bookings_30d).toBe(1)
    // Pretend "now" is 60 days later — same booking is now 70d old.
    const laterNow = NOW + 60 * 86400 * 1000
    expect(computeBookingAggregates(bookings, laterNow).total_bookings_30d).toBe(0)
  })
})

// GLOFOX2.1.15 — Glofox interactions → CRM activity mapping.
describe('mapGlofoxInteraction', () => {
  const CONTACT_ID = '00000000-0000-0000-0000-000000000abc'
  const LOCATION_ID = 'a0000000-0000-0000-0000-000000000001'

  it('returns null for null / non-object input', () => {
    expect(mapGlofoxInteraction(null, CONTACT_ID, LOCATION_ID)).toBeNull()
    expect(mapGlofoxInteraction('string', CONTACT_ID, LOCATION_ID)).toBeNull()
  })

  it('returns null when _id is missing', () => {
    expect(mapGlofoxInteraction({ type: 'NOTE' }, CONTACT_ID, LOCATION_ID)).toBeNull()
  })

  it('returns null for unknown interaction types', () => {
    expect(mapGlofoxInteraction({
      _id: 'i1',
      type: 'BRAND_NEW_TYPE',
    }, CONTACT_ID, LOCATION_ID)).toBeNull()
  })

  it('maps NOTE to type=note with the description carried as note', () => {
    const out = mapGlofoxInteraction({
      _id: 'i1',
      type: 'NOTE',
      description: 'Member said they have an injury, going easy this week',
      created: 1778108400, // 2026-05-06T23:00:00Z
    }, CONTACT_ID, LOCATION_ID)
    expect(out).toMatchObject({
      contact_id: CONTACT_ID,
      location_id: LOCATION_ID,
      type: 'note',
      subject: 'Note',
      note: 'Member said they have an injury, going easy this week',
      done: true,
      source: 'glofox',
      glofox_interaction_id: 'i1',
    })
    expect(out.created_at).toBe('2026-05-06T23:00:00.000Z')
  })

  it('maps CALLED_AND_CONNECTED to type=call with explicit subject', () => {
    const out = mapGlofoxInteraction({
      _id: 'i2',
      type: 'CALLED_AND_CONNECTED',
      description: 'Confirmed Saturday booking',
    }, CONTACT_ID, LOCATION_ID)
    expect(out).toMatchObject({
      type: 'call',
      subject: 'Call (connected)',
      note: 'Confirmed Saturday booking',
    })
  })

  it('maps CALLED_AND_NO_ANSWER to type=call with distinct subject', () => {
    const out = mapGlofoxInteraction({
      _id: 'i3',
      type: 'CALLED_AND_NO_ANSWER',
    }, CONTACT_ID, LOCATION_ID)
    expect(out).toMatchObject({
      type: 'call',
      subject: 'Call (no answer)',
    })
  })

  it('maps MANUAL_EMAIL to type=email', () => {
    const out = mapGlofoxInteraction({
      _id: 'i4',
      type: 'MANUAL_EMAIL',
      description: 'Sent membership renewal info',
    }, CONTACT_ID, LOCATION_ID)
    expect(out).toMatchObject({
      type: 'email',
      subject: 'Manual email',
      note: 'Sent membership renewal info',
    })
  })

  it('is case-insensitive on type', () => {
    expect(mapGlofoxInteraction({
      _id: 'i5',
      type: 'note',
    }, CONTACT_ID, LOCATION_ID)?.type).toBe('note')
  })

  it('coerces _id to string', () => {
    const out = mapGlofoxInteraction({
      _id: 12345,
      type: 'NOTE',
    }, CONTACT_ID, LOCATION_ID)
    expect(out.glofox_interaction_id).toBe('12345')
  })

  it('handles missing/malformed created timestamp gracefully', () => {
    const out = mapGlofoxInteraction({
      _id: 'i6',
      type: 'NOTE',
      created: -9999999999, // out of range
    }, CONTACT_ID, LOCATION_ID)
    expect(out.created_at).toBeNull()
  })

  it('always sets source=glofox and done=true', () => {
    const out = mapGlofoxInteraction({
      _id: 'i7',
      type: 'NOTE',
    }, CONTACT_ID, LOCATION_ID)
    expect(out.source).toBe('glofox')
    expect(out.done).toBe(true)
  })
})

// GLOFOX4.2 — pure helper that picks which trial-lifecycle tags
// applyMemberSync should write based on the before/after of a sync.
// applyMemberSync hands the result to writeContactTags which fires
// tag_added sequence triggers + idempotency-guards re-runs.
describe('detectTrialTransitionTags', () => {
  // ── Status transitions (UPDATE-only) ─────────────────────────────
  it('writes glofox_trial_ended when status flips trial → no_sale_trial', () => {
    expect(detectTrialTransitionTags({
      action: 'update', previousStatus: 'trial', newStatus: 'no_sale_trial',
    })).toEqual(['glofox_trial_ended'])
  })

  it('writes glofox_trial_converted when status flips trial → member', () => {
    expect(detectTrialTransitionTags({
      action: 'update', previousStatus: 'trial', newStatus: 'member',
    })).toEqual(['glofox_trial_converted'])
  })

  it('writes glofox_trial_converted when status flips trial → credit_member', () => {
    // Credit Members (class-pack buyers) are still "converted" —
    // they bought a pack instead of a subscription, but they did
    // convert from trial.
    expect(detectTrialTransitionTags({
      action: 'update', previousStatus: 'trial', newStatus: 'credit_member',
    })).toEqual(['glofox_trial_converted'])
  })

  it('does NOT fire trial_ended on CREATE (no prior status to transition from)', () => {
    // A fresh import that happens to come in as no_sale_trial
    // shouldn't be welcomed with "your trial ended" comms.
    expect(detectTrialTransitionTags({
      action: 'create', previousStatus: null, newStatus: 'no_sale_trial',
    })).toEqual([])
  })

  it('does NOT fire on unrelated transitions', () => {
    // cold → trial is a regular trial-start, not an end / conversion.
    expect(detectTrialTransitionTags({
      action: 'update', previousStatus: 'cold', newStatus: 'trial',
    })).toEqual([])
  })

  // ── Threshold tags (fire on CREATE + UPDATE; idempotency in helper) ─
  it('writes glofox_trial_credits_low when credits ≤ 1 on a trial', () => {
    expect(detectTrialTransitionTags({
      action: 'update', previousStatus: 'trial', newStatus: 'trial',
      currentCredits: 1,
    })).toEqual(['glofox_trial_credits_low'])
  })

  it('also fires credits_low at exactly 0 (last booked, none left)', () => {
    expect(detectTrialTransitionTags({
      action: 'update', previousStatus: 'trial', newStatus: 'trial',
      currentCredits: 0,
    })).toEqual(['glofox_trial_credits_low'])
  })

  it('does NOT fire credits_low when credits > 1', () => {
    expect(detectTrialTransitionTags({
      action: 'update', previousStatus: 'trial', newStatus: 'trial',
      currentCredits: 2,
    })).toEqual([])
  })

  it('does NOT fire credits_low when credits is null (no balance to surface)', () => {
    // Subscription members + Paula-style "fetch returned no active
    // packs" both surface as null. Neither should trigger the
    // conversion push — null is "no signal", not "zero".
    expect(detectTrialTransitionTags({
      action: 'update', previousStatus: 'trial', newStatus: 'trial',
      currentCredits: null,
    })).toEqual([])
  })

  it('does NOT fire credits_low for non-trial members even at low credits', () => {
    // Member with 1 credit on a class pack is not a conversion
    // candidate via this trigger — different lifecycle.
    expect(detectTrialTransitionTags({
      action: 'update', previousStatus: 'credit_member', newStatus: 'credit_member',
      currentCredits: 1,
    })).toEqual([])
  })

  it('writes glofox_trial_engaged when ≥2 classes attended in last 30d on a trial', () => {
    expect(detectTrialTransitionTags({
      action: 'update', previousStatus: 'trial', newStatus: 'trial',
      currentAttended: 2,
    })).toEqual(['glofox_trial_engaged'])
  })

  it('does NOT fire engaged at < 2 attended', () => {
    expect(detectTrialTransitionTags({
      action: 'update', previousStatus: 'trial', newStatus: 'trial',
      currentAttended: 1,
    })).toEqual([])
  })

  it('can fire multiple tags in one sync (engaged + credits_low)', () => {
    expect(detectTrialTransitionTags({
      action: 'update', previousStatus: 'trial', newStatus: 'trial',
      currentCredits: 1, currentAttended: 2,
    })).toEqual(['glofox_trial_credits_low', 'glofox_trial_engaged'])
  })

  it('threshold tags fire on CREATE too (fresh import meeting the bar)', () => {
    // A daily-cron CREATE for a Glofox member who's already
    // active should still light up the signals — the operator's
    // sequences enrol them; writeContactTags idempotency stops
    // re-fires on subsequent syncs.
    expect(detectTrialTransitionTags({
      action: 'create', previousStatus: null, newStatus: 'trial',
      currentCredits: 1, currentAttended: 3,
    })).toEqual(['glofox_trial_credits_low', 'glofox_trial_engaged'])
  })
})

// GLOFOX2.6 — Glofox credits → trial_credits_remaining sync.
describe('computeCreditsRemaining', () => {
  it('returns null for null / non-array / empty input', () => {
    expect(computeCreditsRemaining(null)).toBeNull()
    expect(computeCreditsRemaining(undefined)).toBeNull()
    expect(computeCreditsRemaining([])).toBeNull()
    expect(computeCreditsRemaining('not an array')).toBeNull()
  })

  it('returns null when no credit packs are active (e.g., unlimited subscription)', () => {
    expect(computeCreditsRemaining([
      { active: false, num_sessions: 10, available: 5 },
    ])).toBeNull()
  })

  it('uses the available field when present', () => {
    // Peter's trial pack from the live probe — 3 sessions, 1 used.
    expect(computeCreditsRemaining([
      { active: true, num_sessions: 3, bookings: ['b1'], available: 2 },
    ])).toBe(2)
  })

  it('falls back to num_sessions - bookings.length when available is missing', () => {
    expect(computeCreditsRemaining([
      { active: true, num_sessions: 10, bookings: ['b1', 'b2'] },
    ])).toBe(8)
  })

  it('sums across multiple active packs (e.g., subscription + extra pack)', () => {
    expect(computeCreditsRemaining([
      { active: true, num_sessions: 10, bookings: ['b1'], available: 9 },
      { active: true, num_sessions: 4,  bookings: [],     available: 4 },
    ])).toBe(13)
  })

  it('ignores inactive packs in the sum', () => {
    expect(computeCreditsRemaining([
      { active: true,  num_sessions: 10, available: 8 },
      { active: false, num_sessions: 20, available: 20 },
    ])).toBe(8)
  })

  it('treats negative remaining as 0 (overdrawn pack — defensive)', () => {
    expect(computeCreditsRemaining([
      { active: true, num_sessions: 3, bookings: ['b1', 'b2', 'b3', 'b4'], available: -1 },
    ])).toBe(0)
  })

  it('returns null when packs are active but missing both available + num_sessions', () => {
    expect(computeCreditsRemaining([
      { active: true },
    ])).toBeNull()
  })
})

describe('detectCreditMember', () => {
  it('returns false without ctx', () => {
    expect(detectCreditMember({ lead_status: 'MEMBER', active: true }, null)).toBe(false)
  })

  it('returns false when lead_status is not MEMBER', () => {
    const ctx = makeCtx({
      credits: [{ active: true, num_sessions: 10, membership_id: CLASS_PACK_MEMBERSHIP._id }],
      memberships: [CLASS_PACK_MEMBERSHIP],
    })
    expect(detectCreditMember({ lead_status: 'TRIAL', active: true }, ctx)).toBe(false)
    expect(detectCreditMember({ lead_status: 'LEAD', active: true }, ctx)).toBe(false)
  })

  it('returns false when member.active is false', () => {
    const ctx = makeCtx({
      credits: [{ active: true, num_sessions: 10, membership_id: CLASS_PACK_MEMBERSHIP._id }],
      memberships: [CLASS_PACK_MEMBERSHIP],
    })
    expect(detectCreditMember({ lead_status: 'MEMBER', active: false }, ctx)).toBe(false)
  })

  it('returns true on the canonical Cathy/Gillian shape', () => {
    const ctx = makeCtx({
      credits: [{ active: true, num_sessions: 10, membership_id: CLASS_PACK_MEMBERSHIP._id, model: 'programs' }],
      memberships: [CLASS_PACK_MEMBERSHIP],
    })
    expect(detectCreditMember({ lead_status: 'MEMBER', active: true }, ctx)).toBe(true)
  })
})

// CHURN-PREP.2 — current membership plan name extraction.
describe('extractMembershipPlan', () => {
  it('returns null for null / non-object / membership-less input', () => {
    expect(extractMembershipPlan(null)).toBeNull()
    expect(extractMembershipPlan('string')).toBeNull()
    expect(extractMembershipPlan({})).toBeNull()
    expect(extractMembershipPlan({ membership: null })).toBeNull()
    expect(extractMembershipPlan({ membership: 'nope' })).toBeNull()
  })

  it('prefers membership_plan_name — the clean plan label', () => {
    expect(extractMembershipPlan({
      membership: { membership_plan_name: '3 Month Membership', membership_name: '3) The 3 Month Membership - €100 Discount' },
    })).toBe('3 Month Membership')
  })

  it('uses membership_plan_name for class packs (more specific than the catalog name)', () => {
    expect(extractMembershipPlan({
      membership: { membership_plan_name: '10 Class Pack', membership_name: 'Class Packs' },
    })).toBe('10 Class Pack')
  })

  it('falls back to membership_name and strips the operator "N) " sort prefix', () => {
    expect(extractMembershipPlan({
      membership: { membership_plan_name: '', membership_name: '2) The Monthly Membership (€99 FIRST MONTH)' },
    })).toBe('The Monthly Membership (€99 FIRST MONTH)')
  })

  it('returns null when both names are blank (PAYG / lead)', () => {
    expect(extractMembershipPlan({
      membership: { type: 'payg', membership_plan_name: '', membership_name: '' },
    })).toBeNull()
  })

  it('trims surrounding whitespace', () => {
    expect(extractMembershipPlan({
      membership: { membership_plan_name: '  The UN1T Trial  ' },
    })).toBe('The UN1T Trial')
  })
})

// GLOFOX2.1.13 — joined_at parsing for tenure audiences.
describe('parseGlofoxJoinedAt', () => {
  it('returns null for null / non-object input', () => {
    expect(parseGlofoxJoinedAt(null)).toBeNull()
    expect(parseGlofoxJoinedAt('string')).toBeNull()
    expect(parseGlofoxJoinedAt({})).toBeNull()
  })

  it('prefers joined_at over created (operator-set wins)', () => {
    // joined_at set in the past (member transferred from a prior gym),
    // created is "today" because the Glofox row was made now.
    const out = parseGlofoxJoinedAt({
      joined_at: '2024-01-15T00:00:00Z',
      created: 1778108400, // 2026-04-19
    })
    expect(out).toBe('2024-01-15T00:00:00.000Z')
  })

  it('parses joined_at ISO date-time string', () => {
    expect(parseGlofoxJoinedAt({ joined_at: '2025-06-01T12:34:56Z' }))
      .toBe('2025-06-01T12:34:56.000Z')
  })

  it('falls back to created (Unix seconds) when joined_at is missing', () => {
    // Cathy: created=1776711606 (April 19, 2026)
    const out = parseGlofoxJoinedAt({ created: 1776711606 })
    expect(out).toBe('2026-04-20T19:00:06.000Z')
  })

  it('handles created as Unix millis (>10-digit guard)', () => {
    expect(parseGlofoxJoinedAt({ created: 1776711606000 }))
      .toBe('2026-04-20T19:00:06.000Z')
  })

  it('rejects out-of-range created timestamps (sentinel garbage)', () => {
    expect(parseGlofoxJoinedAt({ created: -9_999_999_999 })).toBeNull()
    expect(parseGlofoxJoinedAt({ created: 99_999_999_999_999 })).toBeNull()
  })

  it('returns null when joined_at is unparseable AND created is missing', () => {
    expect(parseGlofoxJoinedAt({ joined_at: 'not a date' })).toBeNull()
    expect(parseGlofoxJoinedAt({ joined_at: '' })).toBeNull()
  })

  it('falls back to created when joined_at is unparseable', () => {
    // Defence-in-depth: bad joined_at shouldn't kill the tenure value
    // entirely if we have a usable created timestamp.
    const out = parseGlofoxJoinedAt({
      joined_at: 'not a date',
      created: 1776711606,
    })
    expect(out).toBe('2026-04-20T19:00:06.000Z')
  })
})

describe('parseGlofoxDate', () => {
  it('returns null for null / empty / unparseable input', () => {
    expect(parseGlofoxDate(null)).toBeNull()
    expect(parseGlofoxDate('')).toBeNull()
    expect(parseGlofoxDate('not a date')).toBeNull()
    expect(parseGlofoxDate({})).toBeNull()
  })

  it('parses ISO date strings, stripping any time component', () => {
    expect(parseGlofoxDate('1990-05-12')).toBe('1990-05-12')
    expect(parseGlofoxDate('1990-05-12T00:00:00Z')).toBe('1990-05-12')
    expect(parseGlofoxDate('1990-05-12T14:30:00.000+01:00')).toBe('1990-05-12')
  })

  it('parses Unix seconds', () => {
    // 1990-05-12 → 642470400 seconds since epoch (UTC)
    expect(parseGlofoxDate(642470400)).toBe('1990-05-12')
  })

  it('parses Unix millis (>10-digit guard)', () => {
    expect(parseGlofoxDate(642470400000)).toBe('1990-05-12')
  })

  it('parses Mongo BSON timestamp shape { sec, usec }', () => {
    expect(parseGlofoxDate({ sec: 642470400, usec: 0 })).toBe('1990-05-12')
  })

  it('rejects out-of-range values (sentinel garbage)', () => {
    expect(parseGlofoxDate(-9_999_999_999)).toBeNull()
    expect(parseGlofoxDate(99_999_999_999_999)).toBeNull()
  })
})

describe('normalizePhone', () => {
  it('returns null for non-string / empty', () => {
    expect(normalizePhone(null)).toBeNull()
    expect(normalizePhone('')).toBeNull()
    expect(normalizePhone(123)).toBeNull()
  })

  it('preserves already-E.164 numbers', () => {
    expect(normalizePhone('+447310018668')).toBe('+447310018668')
    expect(normalizePhone('+353871234567')).toBe('+353871234567')
  })

  it('strips whitespace from E.164 numbers', () => {
    expect(normalizePhone('+44 7310 018668')).toBe('+447310018668')
  })

  it('converts 00-prefix to +-prefix', () => {
    expect(normalizePhone('00447310018668')).toBe('+447310018668')
  })

  it('normalises UK 11-digit 07 mobile to +44', () => {
    // Roisin Leddy from the live Stillorgan payload — 07310018668
    expect(normalizePhone('07310018668')).toBe('+447310018668')
    expect(normalizePhone('07700900123')).toBe('+447700900123')
  })

  it('normalises Irish 10-digit 08 mobile to +353', () => {
    expect(normalizePhone('0871234567')).toBe('+353871234567')
    expect(normalizePhone('0851234567')).toBe('+353851234567')
    expect(normalizePhone('0861234567')).toBe('+353861234567')
    expect(normalizePhone('0891234567')).toBe('+353891234567')
  })

  it('leaves unrecognised formats as-is rather than guessing wrong', () => {
    // Landline (Dublin 01-XXX XXXX), unknown international,
    // mis-formatted strings — preserve the raw value so a bulk
    // normalisation pass can review later.
    expect(normalizePhone('016700100')).toBe('016700100')
    expect(normalizePhone('123')).toBe('123')
  })
})

describe('mapGlofoxSource', () => {
  // Legacy string-only signature still works — many existing
  // call paths pass member.source directly.
  it('maps known Glofox sources (string signature) to leadSourceSchema enum values', () => {
    expect(mapGlofoxSource('WEBPORTAL')).toBe('website')
    expect(mapGlofoxSource('WEB')).toBe('website')
    expect(mapGlofoxSource('WALK_IN')).toBe('walkin')
    expect(mapGlofoxSource('WALKIN')).toBe('walkin')
    expect(mapGlofoxSource('REFERRAL')).toBe('referral')
    expect(mapGlofoxSource('FACEBOOK')).toBe('meta')
    expect(mapGlofoxSource('INSTAGRAM')).toBe('meta')
    expect(mapGlofoxSource('TIKTOK')).toBe('tiktok')
    expect(mapGlofoxSource('BOOKING')).toBe('booking')
    expect(mapGlofoxSource('WHATSAPP')).toBe('whatsapp')
    expect(mapGlofoxSource('CLASSPASS')).toBe('classpass')
  })

  it('is case-insensitive', () => {
    expect(mapGlofoxSource('webportal')).toBe('website')
    expect(mapGlofoxSource('Walk_In')).toBe('walkin')
  })

  it('defaults to "other" for unmapped or missing values', () => {
    expect(mapGlofoxSource('UNKNOWN_SOURCE')).toBe('other')
    expect(mapGlofoxSource('')).toBe('other')
    expect(mapGlofoxSource(null)).toBe('other')
    expect(mapGlofoxSource(undefined)).toBe('other')
  })

  // GLOFOX2.1.8 — full-payload signature reads origin first, then source.
  it('reads member.origin BEFORE member.source (origin takes precedence)', () => {
    // The Shanice case — Glofox sets source='UNKNOWN' for ClassPass
    // users but origin='classpass'. Origin must win.
    expect(mapGlofoxSource({ origin: 'classpass', source: 'UNKNOWN' })).toBe('classpass')
  })

  it('falls through to member.source when origin is missing', () => {
    expect(mapGlofoxSource({ source: 'WEBPORTAL' })).toBe('website')
    expect(mapGlofoxSource({ source: 'FACEBOOK' })).toBe('meta')
  })

  it('falls through to member.source when origin is not in the origin map', () => {
    // A future origin we haven\'t mapped — don\'t hide the legit source.
    expect(mapGlofoxSource({ origin: 'GYMPASS', source: 'WEBPORTAL' })).toBe('website')
  })

  it('full-payload form is case-insensitive on both origin and source', () => {
    expect(mapGlofoxSource({ origin: 'ClassPass' })).toBe('classpass')
    expect(mapGlofoxSource({ source: 'webportal' })).toBe('website')
  })

  it('full-payload form defaults to "other" when neither matches', () => {
    expect(mapGlofoxSource({ origin: 'GYMPASS', source: 'UNKNOWN' })).toBe('other')
    expect(mapGlofoxSource({})).toBe('other')
  })
})

// Lock the live UN1T Stillorgan payload from GLOFOX2.1 dry-run
// against the mapper so future refactors can't silently regress
// the field paths against Glofox's real shape.
describe('mapGlofoxMember (real Glofox payload)', () => {
  const realPayload = {
    _id: '6a01e48ba3409d706800d9f8',
    membership: {
      _id: '620bdab4df0f8054814cd7be',
      type: 'num_classes',
      trial: true,
      membership_name: '1) The UN1T Trial',
      membership_plan_name: 'The UN1T Trial',
    },
    first_name: 'Roisin',
    last_name: 'Leddy',
    phone: '07310018668',
    email: 'roisinled@hotmail.com',
    branch_id: '6155764859810329ec3826b3',
    type: 'member',
    active: true,
    lead_status: 'TRIAL',
    leads: { status: 'TRIAL' },
    name: 'Roisin Leddy',
    role: 'member',
    source: 'WEBPORTAL',
    birth: null,
  }

  it('extracts the right fields', () => {
    const out = mapGlofoxMember(realPayload)
    expect(out.glofox_member_id).toBe('6a01e48ba3409d706800d9f8')
    expect(out.email).toBe('roisinled@hotmail.com')
    expect(out.first_name).toBe('Roisin')
    expect(out.last_name).toBe('Leddy')
    expect(out.name).toBe('Roisin Leddy')
  })

  it('captures TRIAL as the membership status (NOT lead)', () => {
    // Regression guard for the GLOFOX2.1.1 fix — pre-fix this
    // payload mapped to 'lead' because the parser only checked
    // membership.status / active_membership.status.
    expect(mapGlofoxMember(realPayload).glofox_membership_status).toBe('trial')
  })

  it('normalises Roisin\'s UK mobile to E.164 (GLOFOX2.1.2)', () => {
    expect(mapGlofoxMember(realPayload).phone).toBe('+447310018668')
  })

  it('maps WEBPORTAL source to website lead_source (GLOFOX2.1.2)', () => {
    expect(mapGlofoxMember(realPayload).lead_source).toBe('website')
  })

  it('leaves dob null when Glofox birth is null', () => {
    expect(mapGlofoxMember(realPayload).dob).toBeNull()
  })

  it('captures dob when Glofox supplies a birth ISO string', () => {
    const withBirth = { ...realPayload, birth: '1990-05-12' }
    expect(mapGlofoxMember(withBirth).dob).toBe('1990-05-12')
  })

  it('captures dob when Glofox supplies a Mongo BSON timestamp', () => {
    const withBirth = { ...realPayload, birth: { sec: 642470400, usec: 0 } }
    expect(mapGlofoxMember(withBirth).dob).toBe('1990-05-12')
  })
})

// GLOFOX2.1.6 — ClassPass-originated PAYG user (real payload).
// Shanice Callinan from the live UN1T Stillorgan dry-run. Glofox
// classifies her as lead_status='LEAD' (their catch-all) but the
// deeper signals (origin='classpass' + membership.type='payg' +
// active=true + PAYGPAYMENT=true) reveal she's an actively-paying
// customer worth routing into the conversion funnel rather than
// the fresh-leads bucket.
describe('mapGlofoxMember (real Glofox payload — ClassPass PAYG)', () => {
  const shanicePayload = {
    _id: '6a0219cee62c0c6c980bc95f',
    branch_id: '6155764859810329ec3826b3',
    namespace: 'untstillorgan',
    first_name: 'Shanice',
    last_name: 'Callinan',
    phone: '+10000000000',
    email: 'scallinan1263807351@members.classpass.com',
    active: true,
    type: 'member',
    membership: {
      type: 'payg',
      user_membership_id: '6a0219cfb4764c1cf687d640',
      status: 'ACTIVE',
      membership_name: '',
    },
    origin: 'classpass',
    leads: { status: 'LEAD' },
    lead_status: 'LEAD',
    source: 'UNKNOWN',
    MEMBERPURCHASE: false,
    PAYGPAYMENT: true,
    name: 'Shanice Callinan',
    role: 'member',
  }

  it('detects ClassPass PAYG via origin + membership.type signals', () => {
    expect(mapGlofoxMember(shanicePayload).glofox_membership_status).toBe('classpass_payg')
  })

  it('does NOT default to "lead" despite lead_status=LEAD', () => {
    // Regression guard — without the ClassPass synthesis Shanice
    // would land in new_lead alongside form-fillers.
    expect(mapGlofoxMember(shanicePayload).glofox_membership_status).not.toBe('lead')
  })

  it('preserves the +-prefixed phone passthrough', () => {
    expect(mapGlofoxMember(shanicePayload).phone).toBe('+10000000000')
  })

  it('maps ClassPass origin to lead_source=classpass (GLOFOX2.1.8)', () => {
    // Glofox sets source='UNKNOWN' for ClassPass users; the origin
    // field is the real attribution signal. Previously mapped to
    // 'other' which lost the channel.
    expect(mapGlofoxMember(shanicePayload).lead_source).toBe('classpass')
  })
})

// GLOFOX2.1.11 — Real-world Credit Member regressions with Plan A ctx.
//
// Cathy Laverty + Gillian Collins both have an active Class Pack
// (membership 6512ae6b179d3834bb0b7f78), confirmed by /2.0/credits
// probe. Plan A correctly classifies both as credit_member regardless
// of paid-vs-comp'd status. The same data without ctx (legacy code,
// tests that haven't been updated) falls back to plain 'member'.
describe('mapGlofoxMember (real Glofox payload — Gillian, paid Credit Member)', () => {
  const gillianPayload = {
    _id: '69f1319ff6d376b55a0b8add',
    branch_id: '6155764859810329ec3826b3',
    namespace: 'untstillorgan',
    membership: {
      _id: '620bdab4df0f8054814cd7be',
      type: 'num_classes',
      trial: true,
      membership_name: '1) The UN1T Trial',
    },
    first_name: 'Gillian',
    last_name: 'Collins',
    phone: '0871359761',
    email: 'gillianpcollins@gmail.com',
    type: 'member',
    active: true,
    lead_status: 'MEMBER',
    leads: { status: 'MEMBER' },
    source: 'WEBPORTAL',
    MEMBERPURCHASE: true,
    PAYGPAYMENT: true,
    name: 'Gillian Collins',
  }

  // Real /2.0/credits response from the dry-run — 10-pack with 2 used.
  const gillianCtx = makeCtx({
    credits: [{
      _id: '6a0070c10099cc8c8706e067',
      user_id: '69f1319ff6d376b55a0b8add',
      membership_id: CLASS_PACK_MEMBERSHIP._id,
      model: 'programs',
      num_sessions: 10,
      bookings: ['x', 'y'],
      active: true,
      available: 8,
      membership_name: 'Class Packs',
    }],
    memberships: [CLASS_PACK_MEMBERSHIP],
  })

  it('with Plan A ctx — maps to credit_member', () => {
    expect(mapGlofoxMember(gillianPayload, gillianCtx).glofox_membership_status).toBe('credit_member')
  })

  it('without ctx — falls back to plain member (legacy callers)', () => {
    expect(mapGlofoxMember(gillianPayload).glofox_membership_status).toBe('member')
  })

  it('normalises Irish 08X mobile to +353', () => {
    expect(mapGlofoxMember(gillianPayload).phone).toBe('+353871359761')
  })

  it('maps WEBPORTAL source to website lead_source', () => {
    expect(mapGlofoxMember(gillianPayload).lead_source).toBe('website')
  })
})

describe('mapGlofoxMember (real Glofox payload — Cathy, comp\'d Credit Member)', () => {
  // The smoking gun: Plan A correctly identifies Cathy as a Credit
  // Member even though MEMBERPURCHASE=false (her pack was comp'd).
  // The /2.0/credits endpoint surfaces her active 10-pack regardless
  // of how it was acquired.
  const cathyPayload = {
    _id: '69e677b6fd868d85ee088cb3',
    branch_id: '6155764859810329ec3826b3',
    namespace: 'untstillorgan',
    membership: {
      _id: '620bdab4df0f8054814cd7be',
      type: 'num_classes',
      trial: true,
      membership_name: '1) The UN1T Trial',
    },
    first_name: 'Cathy',
    last_name: 'Laverty',
    phone: '0864099944',
    email: 'lavertycathy@hotmail.com',
    type: 'member',
    active: true,
    lead_status: 'MEMBER',
    leads: { status: 'MEMBER' },
    source: 'WEBPORTAL',
    MEMBERPURCHASE: false,
    PAYGPAYMENT: true,
    name: 'Cathy Laverty',
  }

  // Real /2.0/credits response from the dry-run — 10-pack with 1 used.
  const cathyCtx = makeCtx({
    credits: [{
      _id: '69fbab78d6981cfcab034c86',
      user_id: '69e677b6fd868d85ee088cb3',
      membership_id: CLASS_PACK_MEMBERSHIP._id,
      model: 'programs',
      num_sessions: 10,
      bookings: ['z'],
      active: true,
      available: 9,
      membership_name: 'Class Packs',
    }],
    memberships: [CLASS_PACK_MEMBERSHIP],
  })

  it('with Plan A ctx — maps to credit_member (works for comp\'d packs!)', () => {
    expect(mapGlofoxMember(cathyPayload, cathyCtx).glofox_membership_status).toBe('credit_member')
  })

  it('without ctx — falls back to plain member', () => {
    expect(mapGlofoxMember(cathyPayload).glofox_membership_status).toBe('member')
  })

  it('normalises Irish 08X mobile to +353', () => {
    expect(mapGlofoxMember(cathyPayload).phone).toBe('+353864099944')
  })

  it('maps WEBPORTAL source to website lead_source', () => {
    expect(mapGlofoxMember(cathyPayload).lead_source).toBe('website')
  })

  it('captures joined_at from member.created when joined_at is absent (GLOFOX2.1.13)', () => {
    // Cathy's payload has created=1776711606 and no explicit
    // joined_at — we should still surface a tenure date.
    const payloadWithCreated = { ...cathyPayload, created: 1776711606 }
    expect(mapGlofoxMember(payloadWithCreated).joined_at).toBe('2026-04-20T19:00:06.000Z')
  })

  it('captures joined_at from member.joined_at when set (operator import)', () => {
    const payloadWithJoinedAt = {
      ...cathyPayload,
      joined_at: '2024-08-15T00:00:00Z',
      created: 1776711606,
    }
    expect(mapGlofoxMember(payloadWithJoinedAt).joined_at).toBe('2024-08-15T00:00:00.000Z')
  })
})

// previewMemberSync exercises the match-or-create branches via a
// fluent fake of the Supabase query builder. Each db.from(...) call
// returns its own `chain` proxy with .select / .eq / .limit
// methods that record state and end with a Promise of { data }.
//
// fixtures:
//   rowsByGlofoxId / rowsByEmail — contact lookups
//   openDeal                     — { id, stage_id, stage_slug } | null
//                                  preview reads this via
//                                  getOpenDealWithStage (2 queries:
//                                  deals + pipeline_stages-by-id)
function fakeDb({ rowsByGlofoxId = [], rowsByEmail = [], openDeal = null } = {}) {
  function chain(table) {
    let mode = null
    const c = {}
    c.select = () => c
    c.eq = (col) => {
      if (table === 'deals' && col === 'contact_id')        mode = 'open_deal'
      else if (table === 'pipeline_stages' && col === 'id') mode = 'stage_by_id'
      else if (col === 'glofox_member_id')                  mode = 'glofox'
      else if (col === 'email')                             mode = 'email'
      return c
    }
    c.limit = () => c
    c.then = (resolve) => {
      let data
      if (mode === 'glofox')           data = rowsByGlofoxId
      else if (mode === 'email')        data = rowsByEmail
      else if (mode === 'open_deal')    data = openDeal ? [{ id: openDeal.id, stage_id: openDeal.stage_id }] : []
      else if (mode === 'stage_by_id')  data = openDeal ? [{ slug: openDeal.stage_slug }] : []
      else                              data = []
      resolve({ data })
    }
    return c
  }
  return { from: (table) => chain(table) }
}

describe('previewMemberSync', () => {
  // PIPELINE5.4 — deal_action stage_slugs reflect the new classifier
  // taxonomy (active_trial, hot_conversion, active_member, lapsed,
  // dormant, etc.) not the old GLOFOX_STATUS_TO_STAGE_SLUG map.
  // A bare member with no joined_at / created_at / engagement now
  // correctly resolves to 'dormant' rather than 'new_lead' — the
  // classifier defends against the 8k-import-ghost problem.
  const member = { _id: 'g1', email: 'me@x.com', first_name: 'Me', last_name: 'You', phone: '+353871234567' }
  const isoNow = new Date().toISOString()
  const isoDaysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString()

  it('returns invalid when payload has no _id', async () => {
    const out = await previewMemberSync(fakeDb(), 'loc', { email: 'me@x.com' })
    expect(out.action).toBe('invalid')
  })

  it('returns create when nothing matches + proposes a deal (recent join → new_lead)', async () => {
    // To land in new_lead the classifier needs a recent joined_at +
    // a funnel-top status. Without those the contact is a bare
    // record and the classifier correctly drops it to dormant.
    const m = { ...member, joined_at: isoNow, lead_status: 'LEAD' }
    const out = await previewMemberSync(fakeDb(), 'loc', m)
    expect(out.action).toBe('create')
    expect(out.changes.glofox_member_id.to).toBe('g1')
    expect(out.changes.lead_source.to).toBe('other')
    expect(out.deal_action).toEqual({ action: 'create', stage_slug: 'new_lead' })
  })

  it('proposes active_trial stage when Glofox status is trial + just joined', async () => {
    // 14-day grace window for fresh trial members — no attendance
    // needed for active_trial classification.
    const m = { ...member, lead_status: 'TRIAL', joined_at: isoDaysAgo(3) }
    const out = await previewMemberSync(fakeDb(), 'loc', m)
    expect(out.deal_action).toEqual({ action: 'create', stage_slug: 'active_trial' })
  })

  it('proposes dormant for a bare member record (no signals at all)', async () => {
    // Defends the 8k-ghost problem: stale Glofox records with no
    // joined_at, no engagement, no payment history land in dormant.
    const out = await previewMemberSync(fakeDb(), 'loc', member)
    expect(out.deal_action.stage_slug).toBe('dormant')
  })

  it('uses mapped lead_source when Glofox source is supplied', async () => {
    const m = { ...member, source: 'WEBPORTAL' }
    const out = await previewMemberSync(fakeDb(), 'loc', m)
    expect(out.changes.lead_source.to).toBe('website')
  })

  it('proposes create when contact exists but has no open deal (Roisin backfill)', async () => {
    // Even though the contact exists, no deal exists → CREATE.
    // Stage slug comes from the classifier — with a recent
    // joined_at + LEAD status, that's 'new_lead'.
    const existing = { id: 'c1', email: 'me@x.com', first_name: null, last_name: null, phone: null, glofox_member_id: 'g1', glofox_membership_status: null }
    const out = await previewMemberSync(
      fakeDb({ rowsByGlofoxId: [existing], rowsByEmail: [existing], openDeal: null }),
      'loc',
      { ...member, lead_status: 'LEAD', joined_at: isoNow },
    )
    expect(out.action).toBe('update')
    expect(out.deal_action.action).toBe('create')
    expect(out.deal_action.stage_slug).toBe('new_lead')
  })

  // GLOFOX2.6.1 regression — Paula Glynn (trial) and two ClassPass
  // PAYG contacts were imported showing "3 credits" in the CRM
  // because:
  //   1. fetchUserCredits returned [] (no active packs / fetch failure)
  //   2. computeCreditsRemaining([]) returned null
  //   3. applyMemberSync CREATE path skipped the INSERT when null,
  //      letting the mig 001 schema default of 3 win.
  // Fix: CREATE path now always explicit-writes the column.
  // These previewMemberSync tests lock the upstream contract: ctx
  // present means the field is authoritatively-mapped, including
  // null when the member has no credits to count.
  it('mapped.trial_credits_remaining is null when ctx.credits is empty (CREATE side)', async () => {
    const out = await previewMemberSync(
      fakeDb(),
      'loc',
      member,
      { ctx: { credits: [], memberships: new Map() } },
    )
    expect(out.action).toBe('create')
    // CRITICAL: must be null (not undefined, not 3) so the
    // applyMemberSync CREATE INSERT writes a real NULL instead of
    // falling back to the schema default of 3.
    expect(out.mapped.trial_credits_remaining).toBeNull()
  })

  it('change-detection writes null to trial_credits_remaining on existing contact with no credits', async () => {
    const existing = {
      id: 'c1', email: 'me@x.com', glofox_member_id: 'g1',
      glofox_membership_status: 'trial',
      trial_credits_remaining: 3, // the leaked default we want to overwrite
    }
    const out = await previewMemberSync(
      fakeDb({ rowsByGlofoxId: [existing], rowsByEmail: [existing] }),
      'loc',
      member,
      { ctx: { credits: [], memberships: new Map() } },
    )
    expect(out.action).toBe('update')
    expect(out.changes.trial_credits_remaining).toEqual({ from: 3, to: null })
  })

  // PIPELINE5.4 — these tests previously encoded the old
  // status-transition table (trial→no_sale_trial→follow_up_needed,
  // member+inactive→lost_member, etc.). With the classifier as
  // source of truth, the equivalent assertions are now:
  //
  //   - given (status, engagement), classifier returns the target
  //   - if existing deal stage matches target → leave
  //   - if existing deal stage differs from target → move
  //
  // Operator-override semantics (was OPERATOR_ONLY_STAGES) are
  // intentionally NOT re-introduced here. A future commit can
  // add a manually_placed_at column or similar to defer to operator
  // intent; for now the classifier always wins.

  it('proposes leave when deal already at the classifier target', async () => {
    // Bare member record → classifier says 'dormant'. Existing deal
    // is at 'dormant' → leave.
    const existing = { id: 'c1', email: 'me@x.com', glofox_member_id: 'g1', glofox_membership_status: 'trial' }
    const out = await previewMemberSync(
      fakeDb({
        rowsByGlofoxId: [existing], rowsByEmail: [existing],
        openDeal: { id: 'd1', stage_id: 's1', stage_slug: 'dormant' },
      }),
      'loc',
      { ...member, lead_status: 'TRIAL' },  // no joined_at, no attendance → dormant
    )
    expect(out.deal_action.action).toBe('leave')
  })

  it('proposes move when the classifier produces a different stage from the current deal', async () => {
    // Fresh-joined trial member, existing deal sits at the old
    // 'trial_active' slug. Classifier says 'active_trial' (new
    // taxonomy) — so move.
    const existing = { id: 'c1', email: 'me@x.com', glofox_member_id: 'g1', glofox_membership_status: 'trial' }
    const out = await previewMemberSync(
      fakeDb({
        rowsByGlofoxId: [existing], rowsByEmail: [existing],
        openDeal: { id: 'd1', stage_id: 's1', stage_slug: 'trial_active' },
      }),
      'loc',
      { ...member, lead_status: 'TRIAL', joined_at: isoDaysAgo(3) },
    )
    expect(out.deal_action.action).toBe('move')
    expect(out.deal_action.from_slug).toBe('trial_active')
    expect(out.deal_action.to_slug).toBe('active_trial')
  })

  it('proposes move when an ex_member with no recent signal lands in dormant', async () => {
    // Glofox flipped MEMBER → active:false → ex_member mapping. No
    // recent attendance / payment. Classifier returns 'dormant'
    // (not the old 'lost_member' slug).
    const existing = { id: 'c1', email: 'me@x.com', glofox_member_id: 'g1', glofox_membership_status: 'member' }
    const out = await previewMemberSync(
      fakeDb({
        rowsByGlofoxId: [existing], rowsByEmail: [existing],
        openDeal: { id: 'd1', stage_id: 's1', stage_slug: 'member' },
      }),
      'loc',
      { ...member, lead_status: 'MEMBER', active: false },
    )
    expect(out.deal_action.action).toBe('move')
    expect(out.deal_action.to_slug).toBe('dormant')
  })

  it('returns update when only email matches (link to existing CRM contact)', async () => {
    const existing = { id: 'c2', email: 'me@x.com', first_name: 'Existing', last_name: 'Name', phone: '+353000', glofox_member_id: null, glofox_membership_status: null }
    const out = await previewMemberSync(
      fakeDb({ rowsByGlofoxId: [], rowsByEmail: [existing], openDeal: null }),
      'loc',
      member,
    )
    expect(out.action).toBe('update')
    expect(out.existing_id).toBe('c2')
    expect(out.changes.glofox_member_id.to).toBe('g1')
    expect(out.changes.first_name).toBeUndefined()
    expect(out.changes.phone).toBeUndefined()
  })

  it('returns ambiguous when glofox_id and email match different contacts', async () => {
    const byG = { id: 'cA', email: 'old@x.com', glofox_member_id: 'g1' }
    const byE = { id: 'cB', email: 'me@x.com',  glofox_member_id: null }
    const out = await previewMemberSync(
      fakeDb({ rowsByGlofoxId: [byG], rowsByEmail: [byE] }),
      'loc',
      member,
    )
    expect(out.action).toBe('ambiguous')
    expect(out.conflicts.contact_matched_by_glofox_id.id).toBe('cA')
    expect(out.conflicts.contact_matched_by_email.id).toBe('cB')
  })
})

describe('targetDealStageForSync (GLOFOX2.1.5 transitions)', () => {
  // Signature: (previousStatus, newStatus, currentStageSlug).
  // Auto-move only fires when status CHANGED + current stage isn't
  // operator-only. The target is just the canonical stage for the
  // new status.

  it('returns null when the Glofox status hasn\'t changed', () => {
    // Re-syncs are no-ops. Even if the operator manually moved the
    // deal, an unchanged Glofox status never overwrites them.
    expect(targetDealStageForSync('trial', 'trial', 'trial_active')).toBeNull()
    expect(targetDealStageForSync('member', 'member', 'follow_up_needed')).toBeNull()
    expect(targetDealStageForSync(null, null, 'new_lead')).toBeNull()
  })

  it('routes trial → member to the member stage on conversion', () => {
    expect(targetDealStageForSync('trial', 'member', 'trial_active')).toBe('member')
  })

  it('routes member → ex_member to lost_member (lapsed paying customer)', () => {
    expect(targetDealStageForSync('member', 'ex_member', 'member')).toBe('lost_member')
  })

  it('routes trial → no_sale_trial to follow_up_needed (chase the trialist)', () => {
    expect(targetDealStageForSync('trial', 'no_sale_trial', 'trial_active')).toBe('follow_up_needed')
  })

  it('routes tour → no_sale_tour to follow_up_needed', () => {
    expect(targetDealStageForSync('tour', 'no_sale_tour', 'conversion_ready')).toBe('follow_up_needed')
  })

  it('routes cold → tour to conversion_ready (warmed up)', () => {
    expect(targetDealStageForSync('cold', 'tour', 'cold_email_only')).toBe('conversion_ready')
  })

  it('routes no_sale_trial → trial back to trial_active (re-engaged)', () => {
    expect(targetDealStageForSync('no_sale_trial', 'trial', 'follow_up_needed')).toBe('trial_active')
  })

  it('routes classpass_payg → member when ClassPass user takes a subscription', () => {
    // Hot conversion — the operator's primary win condition for
    // ClassPass users. From conversion_ready straight to member.
    expect(targetDealStageForSync('classpass_payg', 'member', 'conversion_ready')).toBe('member')
  })

  it('routes classpass_payg → ex_member to lost_member (ClassPass user lapsed)', () => {
    expect(targetDealStageForSync('classpass_payg', 'ex_member', 'conversion_ready')).toBe('lost_member')
  })

  // GLOFOX2.1.11 — credit_member auto-routing re-enabled now that
  // Plan A detection is reliable. credit_member is no longer in
  // OPERATOR_ONLY_STAGES so the sync routes IN/OUT based on status
  // changes.
  it('routes credit_member → member when Credit Member takes a subscription', () => {
    // The operator\'s primary win for Credit Members — recurring
    // revenue beats one-off pack purchases.
    expect(targetDealStageForSync('credit_member', 'member', 'credit_member')).toBe('member')
  })

  it('routes credit_member → ex_member to lost_member (credits expired, no renewal)', () => {
    expect(targetDealStageForSync('credit_member', 'ex_member', 'credit_member')).toBe('lost_member')
  })

  it('routes trial → credit_member when trialist buys a class pack', () => {
    expect(targetDealStageForSync('trial', 'credit_member', 'trial_active')).toBe('credit_member')
  })

  it('routes member → credit_member when subscription cancels but pack still active', () => {
    // Edge case — a subscription member who downgraded to using
    // only their remaining one-off pack.
    expect(targetDealStageForSync('member', 'credit_member', 'member')).toBe('credit_member')
  })

  it('respects operator-only stages — returning_member is sticky', () => {
    // Operator placed a deal in returning_member after a comeback
    // chat. Even when Glofox status changes, we don't disturb it.
    expect(targetDealStageForSync('member', 'ex_member', 'returning_member')).toBeNull()
  })

  it('respects operator-only stages — new_lead_social is sticky', () => {
    expect(targetDealStageForSync('lead', 'trial', 'new_lead_social')).toBeNull()
  })

  it('returns null when target equals current stage (no-op)', () => {
    // Status changed but the canonical stage is what they're
    // already in (e.g., backfill from null status).
    expect(targetDealStageForSync(null, 'trial', 'trial_active')).toBeNull()
  })

  it('returns null on unknown new status', () => {
    expect(targetDealStageForSync('member', 'something_weird', 'member')).toBeNull()
  })

  it('is case-insensitive on both status arguments', () => {
    expect(targetDealStageForSync('TRIAL', 'MEMBER', 'trial_active')).toBe('member')
  })
})

describe('pipelineStageSlugForStatus (GLOFOX2.1.5 canonical map)', () => {
  it('maps each canonical Glofox status to its pipeline slug', () => {
    expect(pipelineStageSlugForStatus('cold')).toBe('cold_email_only')
    expect(pipelineStageSlugForStatus('tour')).toBe('conversion_ready')
    expect(pipelineStageSlugForStatus('no_sale_tour')).toBe('follow_up_needed')
    expect(pipelineStageSlugForStatus('trial')).toBe('trial_active')
    expect(pipelineStageSlugForStatus('no_sale_trial')).toBe('follow_up_needed')
    expect(pipelineStageSlugForStatus('member')).toBe('member')
    expect(pipelineStageSlugForStatus('credit_member')).toBe('credit_member')
    expect(pipelineStageSlugForStatus('classpass_payg')).toBe('conversion_ready')
    expect(pipelineStageSlugForStatus('ex_member')).toBe('lost_member')
    expect(pipelineStageSlugForStatus('lead')).toBe('new_lead')
  })

  it('is case-insensitive', () => {
    expect(pipelineStageSlugForStatus('TRIAL')).toBe('trial_active')
    expect(pipelineStageSlugForStatus('Member')).toBe('member')
  })

  it('defaults to new_lead for unknown / missing values', () => {
    expect(pipelineStageSlugForStatus('something_weird')).toBe('new_lead')
    expect(pipelineStageSlugForStatus(null)).toBe('new_lead')
    expect(pipelineStageSlugForStatus(undefined)).toBe('new_lead')
    expect(pipelineStageSlugForStatus('')).toBe('new_lead')
  })
})
