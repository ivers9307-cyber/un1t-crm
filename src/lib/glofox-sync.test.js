import { describe, it, expect, vi } from 'vitest'
import {
  mapGlofoxMember,
  mapMembershipStatus,
  previewMemberSync,
  applyMemberSync,
  parseGlofoxDate,
  parseGlofoxJoinedAt,
  normalizePhone,
  mapGlofoxSource,
  pipelineStageSlugForStatus,
  targetDealStageForSync,
  isClassPackMembership,
  detectCreditMember,
  computeBookingAggregates,
  mergeBookingAggregates,
  mapGlofoxInteraction,
  syncGlofoxInteractions,
  computeCreditsRemaining,
  detectTrialTransitionTags,
  shouldStampConversion,
  shouldStampPackCustomer,
  extractMembershipPlan,
  extractMembershipState,
  extractMemberProfile,
  ensureDealForContact,
  hasActivityAtStudio,
  SIBLING_STUDIO_NO_ACTIVITY,
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

describe('extractMembershipState', () => {
  it('returns null when there is no membership object', () => {
    expect(extractMembershipState(null)).toBeNull()
    expect(extractMembershipState({})).toBeNull()
    expect(extractMembershipState({ membership: null })).toBeNull()
  })
  it('lowercases the membership status', () => {
    expect(extractMembershipState({ membership: { status: 'PAUSED' } })).toBe('paused')
    expect(extractMembershipState({ membership: { status: 'ACTIVE' } })).toBe('active')
  })
  it('returns null for a blank status', () => {
    expect(extractMembershipState({ membership: { status: '' } })).toBeNull()
    expect(extractMembershipState({ membership: {} })).toBeNull()
  })
})

describe('extractMemberProfile', () => {
  it('returns all-null fields for an empty / non-object input', () => {
    const out = extractMemberProfile(null)
    expect(out.glofox_membership_expiry).toBeNull()
    expect(out.glofox_membership_price_cents).toBeNull()
    expect(out.glofox_membership_type).toBeNull()
    expect(out.glofox_account_active).toBeNull()
  })

  it('extracts a subscription member payload', () => {
    const out = extractMemberProfile({
      active: true,
      gender: 'female',
      image_url: 'https://img/x.jpg',
      source: 'WEBPORTAL',
      emergency_contact: 'Contact person: Jo, Phone number: 0871234567',
      answers: [{ q: 'Goal', a: 'Strength' }],
      membership: {
        type: 'time',
        expiry_date: 1790809199,
        roaming_enabled: false,
        plan_price: 913,
        subscription: { price: 1013, interval: 'month', interval_count: 6, payment_method_type_id: 'CARD' },
      },
    })
    expect(out.glofox_membership_type).toBe('time')
    expect(out.glofox_membership_expiry).toBe(new Date(1790809199 * 1000).toISOString())
    // Subscription price wins over catalog plan_price; stored in cents.
    expect(out.glofox_membership_price_cents).toBe(101300)
    expect(out.glofox_billing_interval).toBe('6 months')
    expect(out.glofox_payment_method).toBe('CARD')
    expect(out.gender).toBe('female')
    expect(out.glofox_image_url).toBe('https://img/x.jpg')
    expect(out.glofox_source).toBe('WEBPORTAL')
    expect(out.glofox_account_active).toBe(true)
    expect(out.glofox_roaming_enabled).toBe(false)
    expect(out.emergency_contact).toBe('Contact person: Jo, Phone number: 0871234567')
    expect(out.glofox_signup_answers).toEqual([{ q: 'Goal', a: 'Strength' }])
  })

  it('CANCEL-FORM.1: captures the per-member user_membership_id (the id the v3.0 cancel endpoint needs)', () => {
    expect(extractMemberProfile({ membership: { type: 'time', user_membership_id: '6a0219cfb4764c1cf687d640' } }).glofox_user_membership_id)
      .toBe('6a0219cfb4764c1cf687d640')
    expect(extractMemberProfile({ membership: { type: 'time' } }).glofox_user_membership_id).toBeNull()
    expect(extractMemberProfile({ membership: { type: 'time', user_membership_id: '' } }).glofox_user_membership_id).toBeNull()
    expect(extractMemberProfile({ membership: { type: 'time', user_membership_id: 42 } }).glofox_user_membership_id).toBeNull()
    expect(extractMemberProfile(null).glofox_user_membership_id).toBeNull()
  })

  it('falls back to catalog plan_price for a class pack (no subscription)', () => {
    const out = extractMemberProfile({ membership: { type: 'num_classes', plan_price: 20 } })
    expect(out.glofox_membership_price_cents).toBe(2000)
    expect(out.glofox_billing_interval).toBeNull()
    expect(out.glofox_payment_method).toBeNull()
    expect(out.glofox_membership_expiry).toBeNull()
  })

  it('drops the Glofox empty-placeholder emergency contact + not_specified gender', () => {
    const out = extractMemberProfile({
      gender: 'not_specified',
      emergency_contact: 'Contact person: , Phone number: ',
      answers: [],
      membership: {},
    })
    expect(out.gender).toBeNull()
    expect(out.emergency_contact).toBeNull()
    expect(out.glofox_signup_answers).toBeNull()
  })

  // C12 — Glofox gender variants are canonicalised at the producer so
  // newly-synced rows store 'male'/'female'/null, never 'M'/'F'/'P'.
  it('canonicalises Glofox gender variants (case + single-letter codes)', () => {
    expect(extractMemberProfile({ gender: 'Male' }).gender).toBe('male')
    expect(extractMemberProfile({ gender: 'M' }).gender).toBe('male')
    expect(extractMemberProfile({ gender: 'F' }).gender).toBe('female')
    expect(extractMemberProfile({ gender: 'FEMALE' }).gender).toBe('female')
  })
  it('maps the legacy P code (and any unknown value) to null', () => {
    expect(extractMemberProfile({ gender: 'P' }).gender).toBeNull()
    expect(extractMemberProfile({ gender: 'x' }).gender).toBeNull()
    expect(extractMemberProfile({ gender: '' }).gender).toBeNull()
  })

  it('uses singular "month" for an interval count of 1', () => {
    const out = extractMemberProfile({
      membership: { subscription: { price: 179, interval: 'month', interval_count: 1 } },
    })
    expect(out.glofox_billing_interval).toBe('1 month')
  })

  // GYMPASS.1 — capture the Gympass linkage from member.metadata.gympass.
  // Payloads mirror the two live-probed Gympass members (2026-07-20).
  it('captures gympass_member_id from metadata.gympass (payg drop-in)', () => {
    // Tommy Faherty: payg lead, origin=gympass, metadata.gympass.id present.
    const out = extractMemberProfile({
      origin: 'gympass',
      source: 'UNKNOWN',
      membership: { type: 'payg' },
      metadata: { gympass: { id: '3601127012482' } },
    })
    expect(out.gympass_member_id).toBe('3601127012482')
  })

  it('captures gympass_member_id for a FULL member who also uses Gympass (no origin=gympass)', () => {
    // Lucy Thornton: a paying €99 member with NO origin field, but a
    // numeric metadata.gympass.id — coerced to a string. This is the case
    // an origin-only check would miss.
    const out = extractMemberProfile({
      source: 'WEBPORTAL',
      membership: { type: 'time', subscription: { price: 99, interval: 'month', interval_count: 1 } },
      metadata: { gympass: { id: 3602390808954 } },
    })
    expect(out.gympass_member_id).toBe('3602390808954')
  })

  it('leaves gympass_member_id null for ClassPass / non-aggregator / empty members', () => {
    // ClassPass member — metadata.classpass, NOT metadata.gympass.
    expect(extractMemberProfile({
      origin: 'classpass', membership: { type: 'payg' }, metadata: { classpass: { _id: '49722810' } },
    }).gympass_member_id).toBeNull()
    // Ordinary member with no aggregator metadata.
    expect(extractMemberProfile({ membership: { type: 'time' } }).gympass_member_id).toBeNull()
    // Malformed gympass block (no id) and empty input.
    expect(extractMemberProfile({ metadata: { gympass: {} } }).gympass_member_id).toBeNull()
    expect(extractMemberProfile(null).gympass_member_id).toBeNull()
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

  // CLASSPASS-PHONE.2 — the '+' fast-path used to return these untouched,
  // which is how the ClassPass filler reached 1,620 contacts and made every
  // one of them look phone-reachable.
  it('rejects the ClassPass placeholder rather than passing it through', () => {
    expect(normalizePhone('+10000000000')).toBeNull()
    expect(normalizePhone('+1 000 000 0000')).toBeNull()
    expect(normalizePhone('10000000000')).toBeNull()
  })

  it('rejects repeated-digit filler in any format', () => {
    expect(normalizePhone('+0000000')).toBeNull()
    expect(normalizePhone('0000000000')).toBeNull()
    expect(normalizePhone('+1111111111')).toBeNull()
  })

  it('does NOT reject real numbers that merely contain zeros', () => {
    expect(normalizePhone('+353830000000')).toBe('+353830000000')
    expect(normalizePhone('+447300093740')).toBe('+447300093740')
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

  // CLASSPASS-PHONE.2 — this previously asserted the placeholder was
  // PRESERVED, using the ClassPass filler itself as the fixture, so the test
  // locked the bug in: '+10000000000' reached 1,620 contacts and made every
  // one look phone-reachable. A ClassPass member has no shareable phone, so
  // the correct mapping is null.
  it('maps the ClassPass placeholder phone to null, not through', () => {
    expect(mapGlofoxMember(shanicePayload).phone).toBeNull()
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
//   pipelines                    — PIPELINES.5: the location's boards. The
//                                  default is the single enabled derived
//                                  primary board every live location runs, so
//                                  every fixture below keeps its assertions;
//                                  pass [] to model a location with no board.
//   GLOFOXSIBLING.1 — the organisation-wide fallback (glofox-crossover.js),
//   read only when the location-scoped lookups find nothing:
//   crossoverLinks               — the studio's Glofox relationship rows ({ contact_id }), served as
//                                  studio_contacts rows (mig 768: the link table is gone)
//   orgRowsByGlofoxId / orgRowsByEmail — contacts across the organisation
//   contactsById                 — contacts read by id (a link row's contact)
//   lookupError                  — the location-scoped contact read fails
//   writes                       — every insert/update/upsert, in order
function fakeDb({
  rowsByGlofoxId = [], rowsByEmail = [], openDeal = null,
  pipelines = [{ id: 'p-acq', mode: 'derived' }],
  purchases = [],
  crossoverLinks = [], orgRowsByGlofoxId = [], orgRowsByEmail = [], contactsById = {},
  lookupError = null, writes = [], studioWriteError = null,
} = {}) {
  function chain(table) {
    let mode = null
    let scope = null
    let single = false
    let byId = null
    const c = {}
    c.select = () => c
    c.eq = (col, val) => {
      if (col === 'location_id')                            scope = scope || 'location'
      if (col === 'organization_id')                        scope = 'org'
      if (table === 'deals' && col === 'contact_id')        mode = 'open_deal'
      else if (table === 'pipeline_stages' && col === 'slug') mode = 'stage_by_slug'
      else if (table === 'pipeline_stages' && col === 'id') mode = 'stage_by_id'
      else if (table === 'contacts' && col === 'id')        { mode = 'contact_by_id'; byId = val }
      else if (col === 'glofox_member_id')                  mode = 'glofox'
      else if (col === 'email')                             mode = 'email'
      return c
    }
    c.ilike = (col) => { if (col === 'email') mode = 'email'; return c }
    c.limit = () => c
    c.order = () => c
    c.in = () => c
    c.is = () => c
    c.gt = () => c
    c.maybeSingle = () => { single = true; return c }
    c.single = () => { single = true; return c }
    for (const op of ['insert', 'update', 'upsert']) {
      c[op] = (payload) => { writes.push({ table, op, payload }); return c }
    }
    c.then = (resolve) => {
      let data
      if (table === 'pipelines')                                data = pipelines
      else if (table === 'trial_purchases')                     data = purchases
      else if (table === 'locations')                           data = [{ organization_id: 'org-1' }]
      else if (table === 'studio_contacts')                     data = crossoverLinks.map((l) => ({ ...(contactsById[l.contact_id] || { id: l.contact_id, location_id: 'hatch' }), studio_location_id: 'stillorgan', studio_source: 'glofox' }))
      else if (table === 'contact_location_preferences')        data = writes.length && writes.at(-1).table === table ? [{ contact_id: writes.at(-1).payload[0]?.contact_id }] : []
      // ORGCONTACTS.1 — the relationship row (mig 764): an upsert answers its row, an injected error refuses it
      else if (table === 'contact_studios') {
        if (studioWriteError && writes.at(-1)?.table === table) return resolve({ data: null, error: studioWriteError })
        data = writes.length && writes.at(-1).table === table && writes.at(-1).op === 'upsert' ? [{ contact_id: writes.at(-1).payload.contact_id }] : []
      }
      else if (table === 'contacts' && writes.at(-1)?.table === 'contacts' && writes.at(-1)?.op === 'insert' && mode !== 'contact_by_id')
                                                                data = [{ id: 'c-new', ...writes.at(-1).payload }]
      else if (mode === 'contact_by_id')                        data = contactsById[byId] ? [contactsById[byId]] : []
      else if (table === 'contacts' && scope === 'location' && lookupError) return resolve({ data: null, error: lookupError })
      else if (mode === 'glofox')       data = scope === 'org' ? orgRowsByGlofoxId : rowsByGlofoxId
      else if (mode === 'email')        data = scope === 'org' ? orgRowsByEmail : rowsByEmail
      else if (mode === 'open_deal')    data = openDeal ? [{ id: openDeal.id, stage_id: openDeal.stage_id }] : []
      else if (mode === 'stage_by_id')  data = openDeal ? [{ slug: openDeal.stage_slug }] : []
      else if (mode === 'stage_by_slug') data = [{ id: 's-any' }]
      else if (table === 'deals' && writes.length && writes.at(-1).table === 'deals') data = [{ id: 'd-new' }]
      else                              data = []
      resolve({ data: single ? (data[0] ?? null) : data, error: null })
    }
    return c
  }
  return { from: (table) => chain(table) }
}

describe('previewMemberSync', () => {
  // FUNNEL.1 — deal_action stage_slugs reflect the funnel classifier
  // taxonomy (new_lead, first_class, second_class, trial_done,
  // converted, member, classpass, dormant) not the old
  // GLOFOX_STATUS_TO_STAGE_SLUG map. A bare member with no joined_at /
  // created_at / engagement still resolves to 'dormant' — the
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

  it('proposes new_lead when Glofox status is trial + just joined (no classes yet)', async () => {
    // FUNNEL.1 — a fresh trial member with zero attended classes sits
    // in the funnel's first column (new_lead); they only advance to
    // first_class/second_class/trial_done as attendance accrues.
    const m = { ...member, lead_status: 'TRIAL', joined_at: isoDaysAgo(3) }
    const out = await previewMemberSync(fakeDb(), 'loc', m)
    expect(out.deal_action).toEqual({ action: 'create', stage_slug: 'new_lead' })
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
    // Trial member with one recent attended class on the PERSISTED
    // row; existing deal sits at the old 'trial_active' slug.
    // FUNNEL.1 classifier says 'first_class' — so move. Also pins the
    // persisted recent_bookings fallback: this sync carries no live
    // booking fetch, so the attended count MUST come from the
    // existing row or the preview diverges from apply.
    const existing = {
      id: 'c1', email: 'me@x.com', glofox_member_id: 'g1', glofox_membership_status: 'trial',
      last_attended_at: isoDaysAgo(4),
      recent_bookings: [{ status: 'ATTENDED', attended: true }],
    }
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
    expect(out.deal_action.to_slug).toBe('first_class')
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

  // PIPELINE-FLAP.2 — the nightly classifier (pipeline-reclassify) and the
  // glofox-sync reclassify path MUST agree for the same contact. They both
  // call the SAME classifyContact(), but used to read recency from different
  // sources: pipeline-reclassify from the persisted contacts columns, and
  // glofox-sync from the freshly-mapped sync object (`mapped.*`), which is
  // BLANK on a LIST / skipBookings sync (it doesn't recompute attendance).
  // Result: a paid-up, recently-attended member like Fran Martin
  // (status='member', state='active', expiry=NULL, recent last_payment_at +
  // last_attended_at on the row) classified as active_member by the nightly
  // cron but dormant by glofox-sync — the deal flapped Dormant↔Active Member
  // every night. Fix: the sync snapshot falls back to the persisted row
  // (last_attended_at / last_payment_at) so a blank live value can't demote
  // a member who is recent per the stored columns. This test pins the
  // convergence: the same recent-persisted member resolves to active_member.
  it('PIPELINE-FLAP.2 — member with blank live recency falls back to persisted columns (no flap to dormant)', async () => {
    const isoRecentAttend = isoDaysAgo(18) // ≤ ACTIVE_RECENT_DAYS (30)
    const isoRecentPay    = isoDaysAgo(19) // ≤ ACTIVE_PAID_RECENT_DAYS (60)
    // Persisted row: Fran Martin — a real, recently-active member with NO
    // live plan/expiry, recent attendance AND recent payment on the row.
    const existing = {
      id: 'c1', email: 'fran@x.com', glofox_member_id: 'g1',
      glofox_membership_status: 'member',
      glofox_membership_state: 'active',
      glofox_membership_expiry: null,            // no live plan → recency decides
      last_attended_at: isoRecentAttend,         // recent — should keep them active
      last_payment_at:  isoRecentPay,            // recent — should keep them active
      created_at: isoDaysAgo(400),
    }
    // LIST-shape sync member: no membership detail, no booking fetch, so the
    // mapped object carries NO attendance/payment recency — exactly the case
    // that used to collapse both signals to null and demote to dormant.
    const out = await previewMemberSync(
      fakeDb({
        rowsByGlofoxId: [existing], rowsByEmail: [existing],
        openDeal: { id: 'd1', stage_id: 's1', stage_slug: 'member' },
      }),
      'loc',
      { ...member, email: 'fran@x.com', lead_status: 'MEMBER' },
      { skipBookings: true },
    )
    // Must converge with what pipeline-reclassify produces from the same
    // persisted columns: under FUNNEL.1 a member with no converted_at is
    // 'member' (off-funnel), NOT dormant. (Deal already there → leave,
    // i.e. no flap.)
    expect(out.deal_action.to_slug ?? out.deal_action.stage_slug).toBe('member')
    expect(out.deal_action.action).toBe('leave')
    // The preview snapshot must also expose the existing row so the apply
    // path (applyMemberSync → ensureDealForContact) can read the persisted
    // fallback — without this, preview.existing is undefined and the
    // last_attended_at / last_payment_at fallbacks in the apply snapshot are
    // dead (preview.existing?.X === undefined → null → dormant).
    expect(out.existing).toBeTruthy()
    expect(out.existing.last_attended_at).toBe(isoRecentAttend)
    expect(out.existing.last_payment_at).toBe(isoRecentPay)
  })

  it('PIPELINE-FLAP.2 — attendance-only persisted recency keeps a member active (payment masking removed)', async () => {
    // Sharper pin on the ATTENDANCE fallback specifically: the row's only
    // active signal is last_attended_at (no recent payment). Before the fix,
    // the preview proposed-stage read last_attended_at from `mapped` only
    // (blank on a LIST sync) with no persisted fallback, so this member
    // flapped active_member → dormant on every sync while the nightly cron
    // (reading the same persisted last_attended_at) kept them active_member.
    const isoRecentAttend = isoDaysAgo(10) // ≤ ACTIVE_RECENT_DAYS (30)
    const existing = {
      id: 'c1', email: 'fran@x.com', glofox_member_id: 'g1',
      glofox_membership_status: 'member',
      glofox_membership_state: 'active',
      glofox_membership_expiry: null,
      last_attended_at: isoRecentAttend,
      last_payment_at: null,             // NO recent payment — attendance is the only signal
      created_at: isoDaysAgo(400),
    }
    const out = await previewMemberSync(
      fakeDb({
        rowsByGlofoxId: [existing], rowsByEmail: [existing],
        openDeal: { id: 'd1', stage_id: 's1', stage_slug: 'member' },
      }),
      'loc',
      { ...member, email: 'fran@x.com', lead_status: 'MEMBER' },
      { skipBookings: true },
    )
    // FUNNEL.1 taxonomy: an unconverted-at member is 'member', not the
    // old 'active_member' — and still never dormant.
    expect(out.deal_action.to_slug ?? out.deal_action.stage_slug).toBe('member')
    expect(out.deal_action.action).toBe('leave')
  })

  it('FUNNEL.1 — persisted converted_at puts a recent convert in the Converted column on preview', async () => {
    // Pins the converted_at fallback in the preview snapshot: the
    // dry-run reads the PERSISTED stamp (apply is what writes it), so
    // a member converted 10 days ago previews as 'converted' — the
    // same slug the apply-path snapshot and nightly cron produce.
    const existing = {
      id: 'c1', email: 'me@x.com', glofox_member_id: 'g1',
      glofox_membership_status: 'member',
      converted_at: isoDaysAgo(10),
      created_at: isoDaysAgo(400),
    }
    const out = await previewMemberSync(
      fakeDb({
        rowsByGlofoxId: [existing], rowsByEmail: [existing],
        openDeal: { id: 'd1', stage_id: 's1', stage_slug: 'member' },
      }),
      'loc',
      { ...member, lead_status: 'MEMBER' },
      { skipBookings: true },
    )
    expect(out.deal_action.action).toBe('move')
    expect(out.deal_action.to_slug).toBe('converted')
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

  // GLOFOX-DETAIL null-clobber guard — the champ-app profile wizard writes
  // contacts.gender (via /api/me/body-metrics). Glofox frequently has gender
  // blank/'not_specified', so the single-member sync must never NULL out a
  // gender the member set. Fill-when-empty and genuine value updates still
  // flow; only null-over-existing is suppressed, and ONLY for member-owned
  // keys (gender) — other detail keys keep their prior nulling behaviour.
  const detailMember = (overrides = {}) => ({
    ...member,
    membership: { type: 'payg' }, // presence flips on the GLOFOX-DETAIL path
    ...overrides,
  })

  it('does NOT null-clobber a member-set gender when Glofox has none', async () => {
    const existing = { id: 'c1', email: 'me@x.com', glofox_member_id: 'g1', gender: 'female' }
    const out = await previewMemberSync(
      fakeDb({ rowsByGlofoxId: [existing], rowsByEmail: [existing] }),
      'loc',
      detailMember({ gender: 'not_specified' }), // Glofox blank → mapped.gender = null
    )
    expect(out.action).toBe('update')
    // Protected: no change flagged, so the apply loop never writes gender.
    expect(out.changes.gender).toBeUndefined()
  })

  it('still FILLS gender when the CRM value is empty', async () => {
    const existing = { id: 'c1', email: 'me@x.com', glofox_member_id: 'g1', gender: null }
    const out = await previewMemberSync(
      fakeDb({ rowsByGlofoxId: [existing], rowsByEmail: [existing] }),
      'loc',
      detailMember({ gender: 'male' }),
    )
    expect(out.action).toBe('update')
    expect(out.changes.gender).toEqual({ from: null, to: 'male' })
  })

  it('still flags a genuine Glofox gender value update', async () => {
    const existing = { id: 'c1', email: 'me@x.com', glofox_member_id: 'g1', gender: 'female' }
    const out = await previewMemberSync(
      fakeDb({ rowsByGlofoxId: [existing], rowsByEmail: [existing] }),
      'loc',
      detailMember({ gender: 'male' }),
    )
    expect(out.action).toBe('update')
    expect(out.changes.gender).toEqual({ from: 'female', to: 'male' })
  })

  it('does NOT protect other detail keys — emergency_contact null still flags', async () => {
    // Only gender is member-owned; emergency_contact remains Glofox-sourced,
    // so its prior null-clobber behaviour must be unchanged.
    const existing = { id: 'c1', email: 'me@x.com', glofox_member_id: 'g1', emergency_contact: 'ICE: next of kin' }
    const out = await previewMemberSync(
      fakeDb({ rowsByGlofoxId: [existing], rowsByEmail: [existing] }),
      'loc',
      detailMember({ emergency_contact: '' }), // Glofox blank → mapped.emergency_contact = null
    )
    expect(out.action).toBe('update')
    expect(out.changes.emergency_contact).toEqual({ from: 'ICE: next of kin', to: null })
  })

  // LASTATTEND.1 — the bookings fetch is a 30-day window, so a trial who last
  // trained 45 days ago comes back with no attended class at all. The UPDATE
  // path used to write that null straight over the stored date: on 14 Oct
  // 2026, 120 Stillorgan contacts with attended class_bookings rows had a NULL
  // last_attended_at, every one of them last synced 30+ days after their last
  // class. The timestamps are advance-only (mergeBookingAggregates); the
  // windowed counts still refresh.
  describe('booking-aggregate timestamps are advance-only (LASTATTEND.1)', () => {
    const trial = (over = {}) => ({
      id: 'c1', email: 'me@x.com', glofox_member_id: 'g1', glofox_membership_status: 'trial',
      last_attended_at: isoDaysAgo(45), last_booked_at: isoDaysAgo(50),
      total_attended_30d: 1, total_attended_7d: 0, total_bookings_30d: 1, total_noshow_30d: 0,
      ...over,
    })
    const sync = (existing, bookings) => previewMemberSync(
      fakeDb({ rowsByGlofoxId: [existing], rowsByEmail: [existing] }),
      'loc',
      { ...member, lead_status: 'TRIAL' },
      { bookings, skipInteractions: true },
    )

    it('keeps the stored dates when the 30-day fetch has nothing', async () => {
      const existing = trial()
      const out = await sync(existing, [])
      expect(out.action).toBe('update')
      expect(out.changes).not.toHaveProperty('last_attended_at')
      expect(out.changes).not.toHaveProperty('last_booked_at')
      // applyMemberSync writes mapped.* for a changed key, and the classifier
      // reads mapped.* first: both must see the stored date, not null.
      expect(out.mapped.last_attended_at).toBe(existing.last_attended_at)
      expect(out.mapped.last_booked_at).toBe(existing.last_booked_at)
      // The windowed counts are a fresh answer and still refresh to 0.
      expect(out.changes.total_attended_30d).toEqual({ from: 1, to: 0 })
    })

    it('keeps a newer stored date over an older fresh one', async () => {
      const existing = trial({ last_attended_at: isoDaysAgo(2) })
      const tenDaysAgoSec = Math.floor((Date.now() - 10 * 86_400_000) / 1000)
      const out = await sync(existing, [{ _id: 'b1', created: tenDaysAgoSec, time_start: tenDaysAgoSec, attended: true, status: 'BOOKED' }])
      expect(out.changes).not.toHaveProperty('last_attended_at')
      expect(out.mapped.last_attended_at).toBe(existing.last_attended_at)
    })

    it('advances to a newer attended class', async () => {
      const existing = trial()
      const threeDaysAgoSec = Math.floor((Date.now() - 3 * 86_400_000) / 1000)
      const fresh = new Date(threeDaysAgoSec * 1000).toISOString()
      const out = await sync(existing, [{ _id: 'b1', created: threeDaysAgoSec, time_start: threeDaysAgoSec, attended: true, status: 'BOOKED' }])
      expect(out.changes.last_attended_at).toEqual({ from: existing.last_attended_at, to: fresh })
      expect(out.mapped.last_attended_at).toBe(fresh)
    })

    it('sets the date when none was stored', async () => {
      const existing = trial({ last_attended_at: null, last_booked_at: null })
      const threeDaysAgoSec = Math.floor((Date.now() - 3 * 86_400_000) / 1000)
      const fresh = new Date(threeDaysAgoSec * 1000).toISOString()
      const out = await sync(existing, [{ _id: 'b1', created: threeDaysAgoSec, time_start: threeDaysAgoSec, attended: true, status: 'BOOKED' }])
      expect(out.changes.last_attended_at).toEqual({ from: null, to: fresh })
      expect(out.changes.last_booked_at).toEqual({ from: null, to: fresh })
    })
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

describe('mergeBookingAggregates', () => {
  const counts = {
    total_bookings_30d: 3, total_attended_30d: 2,
    total_attended_7d: 1, total_noshow_30d: 0,
  }

  it('always takes the fresh windowed counts', () => {
    const patch = mergeBookingAggregates(
      { last_attended_at: '2026-01-01T00:00:00.000Z' },
      { ...counts, last_attended_at: null, last_booked_at: null },
    )
    expect(patch.total_bookings_30d).toBe(3)
    expect(patch.total_attended_30d).toBe(2)
    expect(patch.total_attended_7d).toBe(1)
    expect(patch.total_noshow_30d).toBe(0)
  })

  // The core bug fix: a 30-day fetch that returns nothing must NOT
  // overwrite a real historical attendance date with null.
  it('does not wipe last_attended_at when the fresh value is null', () => {
    const patch = mergeBookingAggregates(
      { last_attended_at: '2026-03-01T10:00:00.000Z', last_booked_at: '2026-03-01T09:00:00.000Z' },
      { ...counts, last_attended_at: null, last_booked_at: null },
    )
    expect(patch).not.toHaveProperty('last_attended_at')
    expect(patch).not.toHaveProperty('last_booked_at')
  })

  it('advances last_attended_at when the fresh value is newer', () => {
    const patch = mergeBookingAggregates(
      { last_attended_at: '2026-03-01T10:00:00.000Z' },
      { ...counts, last_attended_at: '2026-05-20T18:00:00.000Z', last_booked_at: null },
    )
    expect(patch.last_attended_at).toBe('2026-05-20T18:00:00.000Z')
  })

  it('does not regress last_attended_at when the fresh value is older', () => {
    const patch = mergeBookingAggregates(
      { last_attended_at: '2026-05-20T18:00:00.000Z' },
      { ...counts, last_attended_at: '2026-03-01T10:00:00.000Z', last_booked_at: null },
    )
    expect(patch).not.toHaveProperty('last_attended_at')
  })

  it('sets last_attended_at when there is no stored value yet', () => {
    const patch = mergeBookingAggregates(
      { last_attended_at: null },
      { ...counts, last_attended_at: '2026-05-20T18:00:00.000Z', last_booked_at: null },
    )
    expect(patch.last_attended_at).toBe('2026-05-20T18:00:00.000Z')
  })

  it('tolerates a null / missing existing row', () => {
    const patch = mergeBookingAggregates(null, {
      ...counts, last_attended_at: '2026-05-20T18:00:00.000Z', last_booked_at: '2026-05-21T08:00:00.000Z',
    })
    expect(patch.last_attended_at).toBe('2026-05-20T18:00:00.000Z')
    expect(patch.last_booked_at).toBe('2026-05-21T08:00:00.000Z')
  })

  it('applies the advance-only rule to last_booked_at independently', () => {
    const patch = mergeBookingAggregates(
      { last_attended_at: null, last_booked_at: '2026-05-25T00:00:00.000Z' },
      { ...counts, last_attended_at: null, last_booked_at: '2026-04-01T00:00:00.000Z' },
    )
    expect(patch).not.toHaveProperty('last_booked_at')
  })
})

describe('shouldStampPackCustomer (FUNNEL.3)', () => {
  it('stamps a non-member holding 4+ active credits (Wendy: cold + 16cr)', () => {
    expect(shouldStampPackCustomer({ newStatus: 'cold', credits: 16, existingPackCustomerAt: null })).toBe(true)
  })
  it('stamps at exactly the 4-credit floor', () => {
    expect(shouldStampPackCustomer({ newStatus: 'lead', credits: 4, existingPackCustomerAt: null })).toBe(true)
  })
  it('write-once: never restamps', () => {
    expect(shouldStampPackCustomer({ newStatus: 'cold', credits: 16, existingPackCustomerAt: '2026-06-01T00:00:00Z' })).toBe(false)
  })
  it('3 credits (a genuine trial / the mig-001 default) never stamps', () => {
    expect(shouldStampPackCustomer({ newStatus: 'trial', credits: 3, existingPackCustomerAt: null })).toBe(false)
  })
  it('members, ClassPass and ex-members never stamp', () => {
    for (const s of ['member', 'credit_member', 'classpass_payg', 'ex_member']) {
      expect(shouldStampPackCustomer({ newStatus: s, credits: 50, existingPackCustomerAt: null })).toBe(false)
    }
  })
  it('null/undefined credits never stamp', () => {
    expect(shouldStampPackCustomer({ newStatus: 'lead', credits: null, existingPackCustomerAt: null })).toBe(false)
    expect(shouldStampPackCustomer({ newStatus: 'lead', credits: undefined, existingPackCustomerAt: null })).toBe(false)
  })
})

describe('shouldStampConversion (FUNNEL.1)', () => {
  const NOW = new Date('2026-07-02T12:00:00Z').getTime()
  const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString()

  it('stamps on lead→member transition', () => {
    expect(shouldStampConversion({
      action: 'update', previousStatus: 'lead', newStatus: 'member',
      existingConvertedAt: null, joinedAt: daysAgo(30), now: NOW,
    })).toBe(true)
  })
  it('stamps on trial→credit_member transition', () => {
    expect(shouldStampConversion({
      action: 'update', previousStatus: 'trial', newStatus: 'credit_member',
      existingConvertedAt: null, joinedAt: daysAgo(10), now: NOW,
    })).toBe(true)
  })
  it('write-once: never restamps when converted_at already set', () => {
    expect(shouldStampConversion({
      action: 'update', previousStatus: 'trial', newStatus: 'member',
      existingConvertedAt: daysAgo(5), joinedAt: daysAgo(10), now: NOW,
    })).toBe(false)
  })
  it('no stamp on member→member re-sync (no transition)', () => {
    expect(shouldStampConversion({
      action: 'update', previousStatus: 'member', newStatus: 'member',
      existingConvertedAt: null, joinedAt: daysAgo(300), now: NOW,
    })).toBe(false)
  })
  it('no stamp on member→credit_member (already a member)', () => {
    expect(shouldStampConversion({
      action: 'update', previousStatus: 'member', newStatus: 'credit_member',
      existingConvertedAt: null, joinedAt: daysAgo(300), now: NOW,
    })).toBe(false)
  })
  it('create path: stamps a direct join (created as member, joined ≤60d)', () => {
    expect(shouldStampConversion({
      action: 'create', previousStatus: null, newStatus: 'member',
      existingConvertedAt: null, joinedAt: daysAgo(2), now: NOW,
    })).toBe(true)
  })
  it('create path: does NOT stamp a long-standing member appearing for the first time', () => {
    expect(shouldStampConversion({
      action: 'create', previousStatus: null, newStatus: 'member',
      existingConvertedAt: null, joinedAt: daysAgo(200), now: NOW,
    })).toBe(false)
  })
  it('no stamp when newStatus is not a member status', () => {
    expect(shouldStampConversion({
      action: 'update', previousStatus: 'lead', newStatus: 'trial',
      existingConvertedAt: null, joinedAt: daysAgo(5), now: NOW,
    })).toBe(false)
  })

  // Null previousStatus on the update path = pre-existing CRM contact
  // (web form / import) being LINKED to a Glofox member for the first
  // time — same pollution risk as the create path, so the same
  // join-recency gate applies.
  it('update path, null previousStatus: stamps a fresh join (lead-form contact linked to a recent member)', () => {
    expect(shouldStampConversion({
      action: 'update', previousStatus: null, newStatus: 'member',
      existingConvertedAt: null, joinedAt: daysAgo(5), now: NOW,
    })).toBe(true)
  })
  it('update path, null previousStatus: does NOT stamp a long-standing member first linked', () => {
    expect(shouldStampConversion({
      action: 'update', previousStatus: null, newStatus: 'member',
      existingConvertedAt: null, joinedAt: daysAgo(200), now: NOW,
    })).toBe(false)
  })
  it('update path, null previousStatus: does NOT stamp when joinedAt is missing', () => {
    expect(shouldStampConversion({
      action: 'update', previousStatus: null, newStatus: 'member',
      existingConvertedAt: null, joinedAt: null, now: NOW,
    })).toBe(false)
  })
})

describe('syncGlofoxInteractions — echo reconciliation (GLOFOX-NOTES)', () => {
  const secs = (iso) => Math.floor(new Date(iso).getTime() / 1000)

  // Fake db exposing the two tables the sync now touches. `pushes` is what the
  // ledger SELECT returns for this contact.
  function makeDb({ pushes = [], claimSpy = () => {}, activitySpy = () => {}, claimError = null }) {
    return {
      from: (t) => {
        if (t === 'glofox_note_pushes') return {
          select: () => ({ eq: () => Promise.resolve({ data: pushes, error: null }) }),
          update: (patch) => ({ eq: (col, val) => { claimSpy({ patch, col, val }); return Promise.resolve({ error: claimError }) } }),
        }
        if (t === 'activities') return { upsert: (row) => { activitySpy(row); return Promise.resolve({ error: null }) } }
        throw new Error(`unexpected table ${t}`)
      },
    }
  }

  it('claims a matching echo (stamps the ledger row) and does NOT duplicate it into activities', async () => {
    const push = { id: 'p1', contact_id: 'c1', type: 'NOTE', description: '[UN1T CRM · Jane] hi', pushed_at: '2026-07-04T10:00:00Z', glofox_interaction_id: null }
    const claimSpy = vi.fn(); const activitySpy = vi.fn()
    const db = makeDb({ pushes: [push], claimSpy, activitySpy })
    const interaction = { _id: 'g'.repeat(24), type: 'NOTE', description: '[UN1T CRM · Jane] hi', created: secs('2026-07-04T10:01:00Z') }
    const r = await syncGlofoxInteractions(db, 'l1', 'c1', [interaction])
    expect(claimSpy).toHaveBeenCalledTimes(1)
    expect(claimSpy.mock.calls[0][0].patch).toMatchObject({ glofox_interaction_id: interaction._id, status: 'reconciled' })
    expect(claimSpy.mock.calls[0][0].val).toBe('p1') // claimed by ledger row id
    expect(activitySpy).not.toHaveBeenCalled()
    expect(r.reconciled).toBe(1)
  })

  it('skips an interaction whose _id is already claimed on the ledger (no re-import)', async () => {
    const claimed = { id: 'p1', contact_id: 'c1', type: 'NOTE', description: 'x', pushed_at: '2026-07-04T10:00:00Z', glofox_interaction_id: 'g'.repeat(24) }
    const activitySpy = vi.fn()
    const db = makeDb({ pushes: [claimed], activitySpy })
    const interaction = { _id: 'g'.repeat(24), type: 'NOTE', description: 'anything', created: secs('2026-07-04T10:05:00Z') }
    await syncGlofoxInteractions(db, 'l1', 'c1', [interaction])
    expect(activitySpy).not.toHaveBeenCalled()
  })

  it('upserts a genuine (non-echo) interaction into activities', async () => {
    const activitySpy = vi.fn()
    const db = makeDb({ pushes: [], activitySpy })
    const interaction = { _id: 'h'.repeat(24), type: 'NOTE', description: 'front desk note', created: secs('2026-07-04T09:00:00Z') }
    const r = await syncGlofoxInteractions(db, 'l1', 'c1', [interaction])
    expect(activitySpy).toHaveBeenCalledTimes(1)
    expect(r.synced).toBe(1)
  })

  it('a single unreconciled push is claimed by only ONE of two identical echoes', async () => {
    const push = { id: 'p1', contact_id: 'c1', type: 'NOTE', description: 'dup', pushed_at: '2026-07-04T10:00:00Z', glofox_interaction_id: null }
    const claimSpy = vi.fn(); const activitySpy = vi.fn()
    const db = makeDb({ pushes: [push], claimSpy, activitySpy })
    const i1 = { _id: 'a'.repeat(24), type: 'NOTE', description: 'dup', created: secs('2026-07-04T10:01:00Z') }
    const i2 = { _id: 'b'.repeat(24), type: 'NOTE', description: 'dup', created: secs('2026-07-04T10:02:00Z') }
    await syncGlofoxInteractions(db, 'l1', 'c1', [i1, i2])
    // First claims the push; second has no unreconciled push left → upserts to activities.
    expect(claimSpy).toHaveBeenCalledTimes(1)
    expect(activitySpy).toHaveBeenCalledTimes(1)
  })

  it('claim UPDATE that resolves with { error } is NOT counted reconciled, NOT upserted, and stays claimable', async () => {
    const push = { id: 'p1', contact_id: 'c1', type: 'NOTE', description: 'dup', pushed_at: '2026-07-04T10:00:00Z', glofox_interaction_id: null }
    const claimSpy = vi.fn(); const activitySpy = vi.fn()
    // supabase RESOLVES (does not throw) with an error on a DB-level failure.
    const db = makeDb({ pushes: [push], claimSpy, activitySpy, claimError: { message: 'boom' } })
    const interaction = { _id: 'a'.repeat(24), type: 'NOTE', description: 'dup', created: secs('2026-07-04T10:01:00Z') }
    const r = await syncGlofoxInteractions(db, 'l1', 'c1', [interaction])
    expect(claimSpy).toHaveBeenCalledTimes(1)     // it DID attempt the claim
    expect(activitySpy).not.toHaveBeenCalled()    // but did NOT create the duplicate
    expect(r.reconciled).toBe(0)                  // and did NOT count it as reconciled
    expect(r.errors).toBe(1)                      // counted as an error instead
    // Second echo (identical) still finds the push unreconciled → tries again.
    const claimSpy2 = vi.fn(); const activitySpy2 = vi.fn()
    const db2 = makeDb({ pushes: [push], claimSpy: claimSpy2, activitySpy: activitySpy2 })
    const echo2 = { _id: 'b'.repeat(24), type: 'NOTE', description: 'dup', created: secs('2026-07-04T10:02:00Z') }
    const r2 = await syncGlofoxInteractions(db2, 'l1', 'c1', [echo2])
    expect(claimSpy2).toHaveBeenCalledTimes(1)
    expect(r2.reconciled).toBe(1)
  })
})

// HATCHPIPE.1 — the sequence fence needs to know WHICH board a placement
// happened on, so the 'move' result names it.
describe('ensureDealForContact — move result names the board (HATCHPIPE.1)', () => {
  function boardDb({ pipelineId = 'p-primary' } = {}) {
    const from = (table) => {
      let mode = null
      const c = {}
      c.select = () => c
      c.update = () => { mode = 'update'; return c }
      c.eq = (col) => {
        if (table === 'pipeline_stages' && col === 'id') mode = 'stage_by_id'
        else if (table === 'pipeline_stages' && col === 'slug') mode = 'stage_by_slug'
        return c
      }
      c.order = () => c
      c.limit = () => c
      c.then = (resolve) => {
        let data = []
        if (table === 'pipelines') data = [{ id: pipelineId, mode: 'derived' }]
        else if (table === 'deals' && mode !== 'update') data = [{ id: 'd1', stage_id: 's-old', pipeline_id: pipelineId }]
        else if (mode === 'stage_by_id') data = [{ slug: 'member' }]
        else if (mode === 'stage_by_slug') data = [{ id: 's-new' }]
        resolve({ data, error: null })
      }
      return c
    }
    return { from }
  }

  it('carries pipeline_id and location_id of the primary board on a move', async () => {
    // A bare snapshot classifies as 'dormant'; the deal sits at 'member'.
    const out = await ensureDealForContact(boardDb(), 'loc-1', 'c1', {}, 'Wendy')
    expect(out).toEqual({
      action: 'move',
      deal_id: 'd1',
      from_slug: 'member',
      to_slug: 'dormant',
      pipeline_id: 'p-primary',
      location_id: 'loc-1',
    })
  })
})

// GLOFOXSIBLING.1 — a Glofox member whose one contact lives at a sibling
// studio of the same organisation (one contact per email per org, mig 712).
describe('previewMemberSync / applyMemberSync — sibling-studio contact (GLOFOXSIBLING.1)', () => {
  const member = { _id: 'g1', email: 'craig@x.com', first_name: 'Craig', last_name: 'C', phone: '+447000000000' }
  const hatch = (over = {}) => ({ id: 'c-hatch', location_id: 'hatch', email: 'craig@x.com', first_name: 'Craig', last_name: 'C', phone: null, glofox_member_id: null, ...over })

  it('a miss at the studio finds the organisation contact by email: update it, never create', async () => {
    const out = await previewMemberSync(fakeDb({ orgRowsByEmail: [hatch()] }), 'stillorgan', member)
    expect(out.action).toBe('update')
    expect(out.existing_id).toBe('c-hatch')
    expect(out.crossover).toEqual({ how: 'email', home_location_id: 'hatch' })
    expect(out.changes.glofox_member_id).toEqual({ from: null, to: 'g1' })
    // the home studio's name is kept; only an empty phone is filled
    expect(out.changes.first_name).toBeUndefined()
    expect(out.changes.phone).toEqual({ from: null, to: '+447000000000' })
  })

  it('a contact already linked at the studio (its contact_studios row, source glofox) is found by it', async () => {
    const out = await previewMemberSync(fakeDb({
      crossoverLinks: [{ contact_id: 'c-hatch' }], contactsById: { 'c-hatch': hatch({ glofox_member_id: 'g1' }) },
    }), 'stillorgan', member)
    expect(out.action).toBe('update')
    expect(out.crossover).toEqual({ how: 'link', home_location_id: 'hatch' })
  })

  it('a contact at the studio is never a crossover (the org fallback is not read)', async () => {
    const out = await previewMemberSync(fakeDb({
      rowsByEmail: [{ id: 'c-here', email: 'craig@x.com', glofox_member_id: null }], orgRowsByEmail: [hatch()],
    }), 'stillorgan', member)
    expect(out.action).toBe('update')
    expect(out.existing_id).toBe('c-here')
    expect(out.crossover).toBeUndefined()
  })

  it('the email holder is linked to a DIFFERENT Glofox member: ambiguous, never overwritten', async () => {
    const out = await previewMemberSync(fakeDb({ orgRowsByEmail: [hatch({ glofox_member_id: 'g-other' })] }), 'stillorgan', member)
    expect(out.action).toBe('ambiguous')
    expect(out.conflicts).toEqual({ sibling_studio_contact_ids: ['c-hatch'] })
    expect(out.reason).toMatch(/different Glofox member/)
  })

  it('two organisation contacts for the member: ambiguous', async () => {
    const out = await previewMemberSync(fakeDb({
      orgRowsByGlofoxId: [hatch({ glofox_member_id: 'g1' })], orgRowsByEmail: [hatch({ id: 'c-other' })],
    }), 'stillorgan', member)
    expect(out.action).toBe('ambiguous')
    expect(out.conflicts.sibling_studio_contact_ids.sort()).toEqual(['c-hatch', 'c-other'])
  })

  it('a failed studio lookup is an error, not a miss: apply writes nothing', async () => {
    const writes = []
    const db = fakeDb({ lookupError: { message: 'boom' }, orgRowsByEmail: [hatch()], writes })
    const preview = await previewMemberSync(db, 'stillorgan', member)
    expect(preview).toMatchObject({ action: 'error', error: 'contact lookup: boom' })
    const applied = await applyMemberSync(db, 'stillorgan', member, { skipBookings: true, skipInteractions: true })
    expect(applied.action).toBe('error')
    expect(writes).toEqual([])
  })

  it('apply updates the sibling contact, links it at the studio, and gives it the studio preferences row', async () => {
    const writes = []
    const out = await applyMemberSync(fakeDb({ orgRowsByEmail: [hatch()], writes }), 'stillorgan', member, { skipBookings: true, skipInteractions: true })
    expect(out.contact_id).toBe('c-hatch')
    expect(out.error).toBeUndefined()
    expect(writes.some((w) => w.table === 'contacts' && w.op === 'insert')).toBe(false)
    const update = writes.find((w) => w.table === 'contacts' && w.op === 'update')
    expect(update.payload.glofox_member_id).toBe('g1')
    expect(update.payload).not.toHaveProperty('location_id')
    // ORGCONTACTS.5 (mig 768): the link IS the contact_studios row with source glofox.
    expect(writes.some((w) => w.table === 'glofox_crossover_members')).toBe(false)
    const link = writes.find((w) => w.table === 'contact_studios')
    expect(link).toMatchObject({ op: 'upsert', payload: { location_id: 'stillorgan', contact_id: 'c-hatch', source: 'glofox' } })
    const prefs = writes.find((w) => w.table === 'contact_location_preferences')
    expect(prefs.payload[0]).toMatchObject({ contact_id: 'c-hatch', location_id: 'stillorgan', source: 'glofox_sync' })
    expect(out.crossover_link).toMatchObject({ linked: true, preferences_created: 1 })
  })
})

// ORGCONTACTS.1 (plan Task 9) — applyMemberSync dual-writes the relationship
// table (mig 764; src/lib/contact-studios.js): a member row for a bookable
// member, a client row for any other Glofox account, at the Glofox studio,
// and at the crossover studio through recordGlofoxCrossover. A failed write
// is logged and reported on the apply result, never fatal.
describe('applyMemberSync — contact_studios dual-write (ORGCONTACTS.1)', () => {
  const lead = { _id: 'g1', email: 'me@x.com', first_name: 'Me', last_name: 'You', phone: '+353871234567', joined_at: '2026-02-01T00:00:00.000Z' }
  const studioRow = (writes) => writes.find((w) => w.table === 'contact_studios' && w.op === 'upsert')

  it('a bookable member writes a member row at the studio, first_seen_at from joined_at', async () => {
    const writes = []
    const out = await applyMemberSync(fakeDb({ writes }), 'stillorgan', { ...lead, membership_status: 'MEMBER', active: true }, { skipBookings: true, skipInteractions: true })
    expect(out.error).toBeUndefined()
    expect(out.contact_studio).toEqual({ ok: true })
    expect(studioRow(writes).payload).toMatchObject({ location_id: 'stillorgan', kind: 'member', status: 'active', source: 'glofox', ended_at: null })
    expect(studioRow(writes).payload).not.toHaveProperty('last_seen_at')
    const seen = writes.find((w) => w.table === 'contact_studios' && w.op === 'update')
    expect(seen.payload).toEqual({ first_seen_at: '2026-02-01T00:00:00.000Z' })
  })

  it('a Glofox account with no live membership writes a client row', async () => {
    const writes = []
    const out = await applyMemberSync(fakeDb({ writes }), 'stillorgan', lead, { skipBookings: true, skipInteractions: true })
    expect(out.contact_studio).toEqual({ ok: true })
    expect(studioRow(writes).payload).toMatchObject({ kind: 'client', source: 'glofox' })
  })

  it('a sibling-studio contact gets the row at the Glofox studio through the crossover link', async () => {
    const writes = []
    const hatch = { id: 'c-hatch', location_id: 'hatch', email: 'me@x.com', first_name: 'Me', last_name: 'You', phone: null, glofox_member_id: null }
    const out = await applyMemberSync(fakeDb({ orgRowsByEmail: [hatch], writes }), 'stillorgan', lead, { skipBookings: true, skipInteractions: true })
    expect(out.contact_id).toBe('c-hatch')
    expect(out.crossover_link).toMatchObject({ linked: true, contact_studio: { ok: true } })
    const rows = writes.filter((w) => w.table === 'contact_studios' && w.op === 'upsert')
    expect(rows.map((w) => [w.payload.location_id, w.payload.contact_id, w.payload.kind])).toEqual([['stillorgan', 'c-hatch', 'client']])
  })

  it('a failed contact_studios write is logged and the apply result still succeeds', async () => {
    const writes = []
    const out = await applyMemberSync(fakeDb({ writes, studioWriteError: { message: 'relation does not exist' } }), 'stillorgan', lead, { skipBookings: true, skipInteractions: true })
    expect(out.error).toBeUndefined()
    expect(out.action).toBe('create')
    expect(out.contact_studio).toMatchObject({ ok: false, error: expect.stringMatching(/relation does not exist/) })
  })
})

// CROSSOVERDEAL.1 — a sibling-studio contact (GLOFOXSIBLING.1) gets a deal on
// the Glofox studio's board only when they have done something AT that
// studio. 12 Hatch clients whose Stillorgan Glofox account was a race entry or
// an untouched trial landed in Stillorgan's New Leads / Dormant columns the
// night the crossover link shipped and were cold-called as Stillorgan leads.
describe('CROSSOVERDEAL.1 — a sibling-studio contact is placed on this board only for activity here', () => {
  const member = { _id: 'g1', email: 'caoilin@x.com', first_name: 'Caoilin', last_name: 'C', phone: '+353851391500', lead_status: 'LEAD', joined_at: new Date().toISOString() }
  const hatch = (over = {}) => ({ id: 'c-hatch', location_id: 'hatch', email: 'caoilin@x.com', first_name: 'Caoilin', last_name: 'C', phone: null, glofox_member_id: null, ...over })
  const sec = (iso) => Math.floor(new Date(iso).getTime() / 1000)
  const attended = () => [{ created: sec(new Date(Date.now() - 3 * 86_400_000).toISOString()), time_start: sec(new Date(Date.now() - 2 * 86_400_000).toISOString()), status: 'BOOKED', attended: true }]
  const dealWrites = (writes) => writes.filter((w) => w.table === 'deals')

  describe('hasActivityAtStudio', () => {
    it('nothing done here: a lead or trial with no classes, no stamps', () => {
      expect(hasActivityAtStudio({})).toBe(false)
      expect(hasActivityAtStudio({ glofox_membership_status: 'lead', total_attended_30d: 0, recent_bookings: [], trial_credits_remaining: 3 })).toBe(false)
      expect(hasActivityAtStudio({ glofox_membership_status: 'trial', joined_at: new Date().toISOString() })).toBe(false)
    })
    it('attended, booked, paying, converted or a pack here is activity', () => {
      expect(hasActivityAtStudio({ last_attended_at: '2026-10-21T18:15:00Z' })).toBe(true)
      expect(hasActivityAtStudio({ total_attended_30d: 1 })).toBe(true)
      expect(hasActivityAtStudio({ total_attended_7d: 1 })).toBe(true)
      expect(hasActivityAtStudio({ recent_bookings: [{ status: 'BOOKED' }] })).toBe(true)
      expect(hasActivityAtStudio({ glofox_membership_status: 'credit_member' })).toBe(true)
      expect(hasActivityAtStudio({ glofox_membership_status: 'MEMBER' })).toBe(true)
      expect(hasActivityAtStudio({ converted_at: '2026-10-19T22:38:07Z' })).toBe(true)
      expect(hasActivityAtStudio({ pack_customer_at: '2026-10-19T22:38:06Z' })).toBe(true)
    })
  })

  describe('ensureDealForContact({ noCreate })', () => {
    it('no deal yet + noCreate: skipped, nothing written', async () => {
      const writes = []
      const out = await ensureDealForContact(fakeDb({ writes }), 'stillorgan', 'c-hatch', {}, 'Caoilin', { noCreate: true })
      expect(out).toEqual({ action: 'skipped', reason: SIBLING_STUDIO_NO_ACTIVITY, deal_id: null, stage_slug: 'dormant' })
      expect(writes).toEqual([])
    })
    it('an existing deal still moves under noCreate (a class booking here, or a hand, made it)', async () => {
      const writes = []
      const db = fakeDb({ writes, openDeal: { id: 'd1', stage_id: 's-old', stage_slug: 'new_lead' } })
      const out = await ensureDealForContact(db, 'stillorgan', 'c-hatch', {}, 'Caoilin', { noCreate: true })
      expect(out).toMatchObject({ action: 'move', deal_id: 'd1', from_slug: 'new_lead', to_slug: 'dormant' })
      expect(dealWrites(writes)).toHaveLength(1)
    })
    it('without noCreate the create path is unchanged', async () => {
      const writes = []
      const out = await ensureDealForContact(fakeDb({ writes }), 'stillorgan', 'c-hatch', {}, 'Caoilin')
      expect(out).toMatchObject({ action: 'create', deal_id: 'd-new' })
    })
  })

  describe('applyMemberSync', () => {
    it('a sibling contact with nothing done here gets NO deal on this board (the Caoilin case)', async () => {
      const writes = []
      const out = await applyMemberSync(fakeDb({ orgRowsByEmail: [hatch()], writes }), 'stillorgan', member, { bookings: [], skipInteractions: true })
      expect(out.contact_id).toBe('c-hatch')
      expect(out.crossover).toEqual({ how: 'email', home_location_id: 'hatch' })
      expect(out.deal).toEqual({ action: 'skipped', reason: SIBLING_STUDIO_NO_ACTIVITY, deal_id: null, stage_slug: 'new_lead' })
      expect(dealWrites(writes)).toEqual([])
      // The link (ORGCONTACTS.5: the contact_studios row at the Glofox studio, source glofox)
      // and the studio preferences row are still made.
      expect(writes.some((w) => w.table === 'glofox_crossover_members')).toBe(false)
      expect(writes.find((w) => w.table === 'contact_studios' && w.op === 'upsert')).toMatchObject({ payload: { location_id: 'stillorgan', contact_id: 'c-hatch', source: 'glofox' } })
    })
    it('a sibling contact who attended a class here is a prospect here: the deal is created', async () => {
      const writes = []
      const out = await applyMemberSync(fakeDb({ orgRowsByEmail: [hatch()], writes }), 'stillorgan', member, { bookings: attended(), skipInteractions: true })
      expect(out.deal).toMatchObject({ action: 'create', deal_id: 'd-new' })
      expect(dealWrites(writes)).toHaveLength(1)
      expect(dealWrites(writes)[0].payload).toMatchObject({ contact_id: 'c-hatch', location_id: 'stillorgan', status: 'open' })
    })
    it('a sibling contact whose Stillorgan account is a paying membership keeps a deal', async () => {
      const writes = []
      const paying = { ...member, lead_status: 'MEMBER' }
      const out = await applyMemberSync(fakeDb({ orgRowsByEmail: [hatch()], writes }), 'stillorgan', paying, { bookings: [], skipInteractions: true })
      expect(out.deal).toMatchObject({ action: 'create' })
    })
    it('a sibling contact with an existing deal here is moved or left, never dropped', async () => {
      const writes = []
      const db = fakeDb({ orgRowsByEmail: [hatch()], writes, openDeal: { id: 'd1', stage_id: 's-old', stage_slug: 'new_lead' } })
      const out = await applyMemberSync(db, 'stillorgan', member, { bookings: [], skipInteractions: true })
      expect(out.deal).toMatchObject({ action: 'leave', deal_id: 'd1', stage_slug: 'new_lead' })
    })
    it('a contact who lives AT the studio is not a sibling: the create is unchanged', async () => {
      const writes = []
      const home = { ...hatch(), id: 'c-home', location_id: 'stillorgan' }
      const out = await applyMemberSync(fakeDb({ rowsByEmail: [home], writes }), 'stillorgan', member, { bookings: [], skipInteractions: true })
      expect(out.crossover).toBeUndefined()
      expect(out.deal).toMatchObject({ action: 'create', deal_id: 'd-new', stage_slug: 'new_lead' })
    })
  })

  describe('previewMemberSync mirrors apply', () => {
    it('an idle sibling contact previews deal_action skipped', async () => {
      const out = await previewMemberSync(fakeDb({ orgRowsByEmail: [hatch()] }), 'stillorgan', member, { bookings: [] })
      expect(out.action).toBe('update')
      expect(out.deal_action).toEqual({ action: 'skipped', reason: SIBLING_STUDIO_NO_ACTIVITY, stage_slug: 'new_lead' })
    })
    it('a sibling contact with a deal here previews the normal move / leave', async () => {
      const db = fakeDb({ orgRowsByEmail: [hatch()], openDeal: { id: 'd1', stage_id: 's-old', stage_slug: 'new_lead' } })
      const out = await previewMemberSync(db, 'stillorgan', member, { bookings: [] })
      expect(out.deal_action.action).toBe('leave')
    })
    it('a sibling contact who attended here previews a create', async () => {
      const out = await previewMemberSync(fakeDb({ orgRowsByEmail: [hatch()] }), 'stillorgan', member, { bookings: attended() })
      expect(out.deal_action.action).toBe('create')
    })
  })
})

// ---------------------------------------------------------------------------
// PIPE3.7 — the webhook path places through the router when the studio runs
// claim boards, and the trial's own credits are never a Class Pack.
// ---------------------------------------------------------------------------
describe('shouldStampPackCustomer — a live €39 claim (PIPE3.7)', () => {
  it('never stamps while a paid-trial claim is live, whatever the credits', () => {
    expect(shouldStampPackCustomer({ newStatus: 'trial', credits: 10, existingPackCustomerAt: null, liveTrialClaim: true })).toBe(false)
  })
  it('stamps as before once no claim is live', () => {
    expect(shouldStampPackCustomer({ newStatus: 'trial', credits: 10, existingPackCustomerAt: null, liveTrialClaim: false })).toBe(true)
    expect(shouldStampPackCustomer({ newStatus: 'trial', credits: 10, existingPackCustomerAt: null })).toBe(true)
  })
})

describe('ensureDealForContact — three boards (PIPE3.7)', () => {
  const LOC = 'loc-st'
  const NOW = Date.now()
  const ago = (d) => new Date(NOW - d * 86_400_000).toISOString()
  const THREE = [
    { id: 'p-acq', location_id: LOC, key: 'acquisition', module: 'acquisition', mode: 'derived', enabled: true, is_primary: true },
    { id: 'p-paid', location_id: LOC, key: 'paid_trial', module: 'paid_trial', mode: 'derived', enabled: true, is_primary: false },
    { id: 'p-prog', location_id: LOC, key: 'programmes', module: 'programmes', mode: 'derived', enabled: true, is_primary: false },
  ]
  const STAGES = [
    ...['new_lead', 'pack_member', 'dormant', 'member'].map((slug) => ({ id: `s-${slug}`, slug, pipeline_id: 'p-acq' })),
    ...['paid_trial_new_lead', 'paid_trial_day_7'].map((slug) => ({ id: `s-${slug}`, slug, pipeline_id: 'p-paid' })),
    ...['programme_lead'].map((slug) => ({ id: `s-${slug}`, slug, pipeline_id: 'p-prog' })),
  ]
  const RULES = { pipelines: { programmes: { lead_sources: ['meta_50plus'], glofox_plan_patterns: ['elites trial'] } } }

  // A fluent fake over named tables; writes are recorded with their filters.
  function threeBoardDb({ pipelines = THREE, deals = [], purchases = [], claims = [], errors = {} } = {}) {
    // The pipelines read filters enabled = true like the real table.
    pipelines = pipelines.filter((p) => p.enabled !== false || true)
    const tables = { pipelines, pipeline_stages: STAGES, deals, trial_purchases: purchases, pipeline_board_claims: claims, locations: [{ id: LOC, settings: RULES }] }
    const writes = []
    const reads = []
    function chain(table) {
      reads.push(table)
      const filters = []
      let op = 'select'
      let payload = null
      const c = {}
      c.select = () => c
      c.order = () => c
      c.limit = () => c
      c.single = () => { if (op === 'select') op = 'single'; return c }
      c.maybeSingle = () => { if (op === 'select') op = 'single'; return c }
      c.eq = (col, val) => { filters.push({ col, val }); return c }
      c.in = () => c
      c.update = (f) => { op = 'update'; payload = f; return c }
      c.insert = (f) => { op = 'insert'; payload = f; return c }
      c.upsert = (f, o) => { op = 'upsert'; payload = { rows: f, opts: o }; return c }
      const apply = (rows) => (rows || []).filter((r) => filters.every((f) => !Object.prototype.hasOwnProperty.call(r, f.col) || r[f.col] === f.val))
      c.then = (resolve) => {
        if (errors[table] && op !== 'update' && op !== 'insert' && op !== 'upsert') return resolve({ data: null, error: { message: errors[table] } })
        if (op === 'update' || op === 'insert' || op === 'upsert') {
          writes.push({ table, op, payload, filters })
          return resolve({ data: op === 'insert' ? { id: 'd-new' } : null, error: null })
        }
        const rows = apply(tables[table])
        return resolve({ data: op === 'single' ? (rows[0] ?? null) : rows, error: null })
      }
      return c
    }
    return { db: { from: chain }, writes, reads }
  }
  const trialer = { glofox_membership_status: 'trial', trial_credits_remaining: 10, pack_customer_at: ago(2), joined_at: ago(2), created_at: ago(2), recent_bookings: [] }
  const purchase = { id: 'tp1', location_id: LOC, contact_id: 'c1', status: 'granted', payment_status: 'paid', paid_at: ago(2), granted_at: ago(2), duration_days: 14 }

  it('a €39 buyer with an acquisition deal at pack_member moves to the €39 board: stage AND pipeline in one update', async () => {
    const { db, writes } = threeBoardDb({
      deals: [{ id: 'd1', contact_id: 'c1', location_id: LOC, pipeline_id: 'p-acq', stage_id: 's-pack_member', status: 'open' }],
      purchases: [purchase],
    })
    const out = await ensureDealForContact(db, LOC, 'c1', trialer, 'Buyer')
    expect(out).toEqual({
      action: 'move', deal_id: 'd1', from_slug: 'pack_member', to_slug: 'paid_trial_new_lead',
      pipeline_id: 'p-paid', location_id: LOC, from_board: 'acquisition', to_board: 'paid_trial',
    })
    const updates = writes.filter((w) => w.table === 'deals' && w.op === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].payload).toEqual({ stage_id: 's-paid_trial_new_lead', pipeline_id: 'p-paid' })
    expect(updates[0].filters).toEqual([{ col: 'id', val: 'd1' }])
  })

  it('a /50plus lead with no deal gets a recorded programme claim, then a deal on the Programmes board', async () => {
    const lead = { glofox_membership_status: 'lead', joined_at: ago(1), created_at: ago(1), recent_bookings: [], last_lead_source: 'meta_50plus', last_lead_source_at: ago(1) }
    const { db, writes } = threeBoardDb()
    const out = await ensureDealForContact(db, LOC, 'c2', lead, 'Fifty')
    expect(out).toMatchObject({ action: 'create', deal_id: 'd-new', stage_slug: 'programme_lead', pipeline_id: 'p-prog' })
    const claim = writes.find((w) => w.table === 'pipeline_board_claims')
    expect(claim.op).toBe('upsert')
    expect(claim.payload.rows[0]).toMatchObject({ contact_id: 'c2', location_id: LOC, board_key: 'programmes', source: 'lead_source' })
    const insert = writes.find((w) => w.table === 'deals' && w.op === 'insert')
    expect(insert.payload).toMatchObject({ contact_id: 'c2', stage_id: 's-programme_lead', pipeline_id: 'p-prog', location_id: LOC, status: 'open' })
    expect(writes.indexOf(claim)).toBeLessThan(writes.indexOf(insert))
  })

  it('pre-loaded claims (opts.claims) are used as given: no purchases, claims or settings read', async () => {
    const { db, reads, writes } = threeBoardDb({
      deals: [{ id: 'd1', contact_id: 'c1', location_id: LOC, pipeline_id: 'p-acq', stage_id: 's-pack_member', status: 'open' }],
    })
    const claims = { paid: { start: NOW - 2 * 86_400_000, end: NOW + 12 * 86_400_000, paidAt: NOW - 2 * 86_400_000, grantedAt: NOW - 2 * 86_400_000, durationDays: 14 }, programme: null }
    const out = await ensureDealForContact(db, LOC, 'c1', trialer, 'Buyer', { claims })
    expect(out.to_slug).toBe('paid_trial_new_lead')
    expect(reads).not.toContain('trial_purchases')
    expect(reads).not.toContain('pipeline_board_claims')
    expect(reads).not.toContain('locations')
    expect(writes.filter((w) => w.table === 'deals')).toHaveLength(1)
  })

  it('a same-board move keeps today\'s stage-only payload and result shape', async () => {
    const { db, writes } = threeBoardDb({
      deals: [{ id: 'd1', contact_id: 'c3', location_id: LOC, pipeline_id: 'p-acq', stage_id: 's-member', status: 'open' }],
    })
    const out = await ensureDealForContact(db, LOC, 'c3', { glofox_membership_status: 'ex_member' }, 'Ex')
    expect(out).toEqual({ action: 'move', deal_id: 'd1', from_slug: 'member', to_slug: 'dormant', pipeline_id: 'p-acq', location_id: LOC })
    expect(writes.find((w) => w.table === 'deals').payload).toEqual({ stage_id: 's-dormant' })
  })

  it('an unreadable trial_purchases read is an error, and nothing is written', async () => {
    const { db, writes } = threeBoardDb({ purchases: [purchase], errors: { trial_purchases: 'down' } })
    const out = await ensureDealForContact(db, LOC, 'c1', trialer, 'Buyer')
    expect(out).toEqual({ action: 'error', error: 'claims unavailable: purchases_unreadable' })
    expect(writes).toHaveLength(0)
  })

  it('a studio with the acquisition board alone reads neither purchases nor claims nor settings', async () => {
    const { db, reads } = threeBoardDb({ pipelines: [THREE[0]], purchases: [purchase] })
    const out = await ensureDealForContact(db, LOC, 'c1', trialer, 'Buyer')
    expect(out.action).toBe('create')
    expect(reads).not.toContain('trial_purchases')
    expect(reads).not.toContain('pipeline_board_claims')
    expect(reads).not.toContain('locations')
  })
})


// PIPE3 fix pass (review #1, #4, #5) — duplicates, disabled boards, pre-loaded boards.
describe('ensureDealForContact — duplicates and pre-loaded boards (PIPE3 fix pass)', () => {
  const LOC = 'loc-st'
  const NOW = Date.now()
  const ago = (d) => new Date(NOW - d * 86_400_000).toISOString()
  const THREE = [
    { id: 'p-acq', location_id: LOC, key: 'acquisition', module: 'acquisition', mode: 'derived', enabled: true, is_primary: true },
    { id: 'p-paid', location_id: LOC, key: 'paid_trial', module: 'paid_trial', mode: 'derived', enabled: true, is_primary: false },
    { id: 'p-prog', location_id: LOC, key: 'programmes', module: 'programmes', mode: 'derived', enabled: true, is_primary: false },
  ]
  const STAGES = [
    ...['new_lead', 'pack_member', 'dormant', 'member'].map((slug) => ({ id: `s-${slug}`, slug, pipeline_id: 'p-acq' })),
    ...['paid_trial_new_lead'].map((slug) => ({ id: `s-${slug}`, slug, pipeline_id: 'p-paid' })),
    ...['programme_lead'].map((slug) => ({ id: `s-${slug}`, slug, pipeline_id: 'p-prog' })),
  ]
  function db3({ deals = [], purchases = [], claims = [], pipelines = THREE } = {}) {
    const tables = { pipelines, pipeline_stages: STAGES, deals, trial_purchases: purchases, pipeline_board_claims: claims, locations: [{ id: LOC, settings: { pipelines: { programmes: { lead_sources: ['meta_50plus'], glofox_plan_patterns: [] } } } }] }
    const writes = []
    const reads = []
    function chain(table) {
      reads.push(table)
      const filters = []
      let op = 'select'
      let payload = null
      const c = {}
      c.select = () => c; c.order = () => c; c.limit = () => c; c.in = () => c
      c.single = () => { if (op === 'select') op = 'single'; return c }
      c.maybeSingle = c.single
      c.eq = (col, val) => { filters.push({ col, val }); return c }
      c.update = (f) => { op = 'update'; payload = f; return c }
      c.insert = (f) => { op = 'insert'; payload = f; return c }
      c.upsert = (f, o) => { op = 'upsert'; payload = { rows: f, opts: o }; return c }
      const apply = (rows) => (rows || []).filter((r) => filters.every((f) => !Object.prototype.hasOwnProperty.call(r, f.col) || r[f.col] === f.val))
      c.then = (resolve) => {
        if (op !== 'select' && op !== 'single') {
          writes.push({ table, op, payload, filters })
          // An UPDATE … .select('id') answers the id it matched, as PostgREST does.
          const idF = filters.find((f) => f.col === 'id')
          const data = op === 'insert' ? { id: 'd-new' } : (op === 'update' && idF ? [{ id: idF.val }] : null)
          return resolve({ data, error: null })
        }
        const rows = apply(tables[table])
        return resolve({ data: op === 'single' ? (rows[0] ?? null) : rows, error: null })
      }
      return c
    }
    return { db: { from: chain }, writes, reads }
  }
  const lead = { glofox_membership_status: 'lead', joined_at: ago(1), created_at: ago(1), recent_bookings: [], last_lead_source: 'meta_50plus', last_lead_source_at: ago(1) }

  it('two open deals: the one on the target board is kept (and moved), the other is closed lost; exactly one open deal remains', async () => {
    const { db, writes } = db3({
      deals: [
        { id: 'd-acq', contact_id: 'c2', location_id: LOC, pipeline_id: 'p-acq', stage_id: 's-new_lead', status: 'open', created_at: ago(0) },
        { id: 'd-prog', contact_id: 'c2', location_id: LOC, pipeline_id: 'p-prog', stage_id: 's-programme_lead', status: 'open', created_at: ago(1) },
      ],
      claims: [{ contact_id: 'c2', location_id: LOC, board_key: 'programmes', claimed_at: ago(1), source: 'lead_source' }],
    })
    const out = await ensureDealForContact(db, LOC, 'c2', lead, 'Fifty')
    expect(out).toMatchObject({ action: 'leave', deal_id: 'd-prog', stage_slug: 'programme_lead', duplicates_closed: 1 })
    const closes = writes.filter((w) => w.table === 'deals' && w.op === 'update' && w.payload.status === 'lost')
    expect(closes).toHaveLength(1)
    expect(closes[0].filters).toContainEqual({ col: 'id', val: 'd-acq' })
    expect(writes.filter((w) => w.table === 'deals' && w.op === 'insert')).toHaveLength(0)
  })

  it('an open deal on a DISABLED board is ignored: the contact gets a deal on the enabled board', async () => {
    const { db, writes } = db3({
      pipelines: [...THREE, { id: 'p-old', location_id: LOC, key: 'returning', module: 'returning', mode: 'derived', enabled: false, is_primary: false }],
      deals: [{ id: 'd-old', contact_id: 'c2', location_id: LOC, pipeline_id: 'p-old', stage_id: 's-x', status: 'open' }],
    })
    const out = await ensureDealForContact(db, LOC, 'c2', lead, 'Fifty')
    expect(out).toMatchObject({ action: 'create', pipeline_id: 'p-prog' })
    expect(writes.filter((w) => w.table === 'deals' && w.op === 'update')).toHaveLength(0)
  })

  it('pre-loaded claims AND boards: no pipelines read at all', async () => {
    const { db, reads } = db3({ deals: [] })
    const claims = { paid: null, programme: { claimedAt: NOW - 86_400_000, source: 'lead_source' } }
    const out = await ensureDealForContact(db, LOC, 'c2', lead, 'Fifty', { claims, boards: THREE })
    expect(out).toMatchObject({ action: 'create', pipeline_id: 'p-prog' })
    expect(reads).not.toContain('pipelines')
    expect(reads).not.toContain('trial_purchases')
  })
})

// PIPE3 fix pass (review #2) — the detail backfill (skipBookings + skipReclassify)
// must not stamp a live €39 buyer as a pack customer from the trial's credits.
describe('applyMemberSync — pack stamp on the skipBookings path (PIPE3 fix pass)', () => {
  const member = { _id: 'g-buyer', email: 'buyer@x.com', first_name: 'Buy', last_name: 'Er', lead_status: 'TRIAL' }
  const existing = { id: 'c-buyer', email: 'buyer@x.com', first_name: 'Buy', last_name: 'Er', glofox_member_id: 'g-buyer', glofox_membership_status: 'trial', trial_credits_remaining: 10, pack_customer_at: null, location_id: 'stillorgan' }
  const granted = { id: 'tp1', location_id: 'stillorgan', contact_id: 'c-buyer', status: 'granted', payment_status: 'paid', paid_at: new Date(Date.now() - 2 * 86_400_000).toISOString(), granted_at: new Date(Date.now() - 2 * 86_400_000).toISOString(), duration_days: 14 }
  const packStamps = (writes) => writes.filter((w) => w.table === 'contacts' && w.op === 'update' && w.payload && 'pack_customer_at' in w.payload)

  it('a live €39 claim withholds the stamp even when the sync skips bookings and placement', async () => {
    const writes = []
    await applyMemberSync(fakeDb({ rowsByGlofoxId: [existing], rowsByEmail: [existing], purchases: [granted], writes }), 'stillorgan', member, { skipBookings: true, skipReclassify: true, skipInteractions: true })
    expect(packStamps(writes)).toHaveLength(0)
  })
  it('with no purchase the same sync stamps as before (10 credits, trial status)', async () => {
    const writes = []
    await applyMemberSync(fakeDb({ rowsByGlofoxId: [existing], rowsByEmail: [existing], purchases: [], writes }), 'stillorgan', member, { skipBookings: true, skipReclassify: true, skipInteractions: true })
    expect(packStamps(writes)).toHaveLength(1)
  })
})


// HATCH39 — once Hatch's primary is the derived un1t.online acquisition board,
// the Glofox-shaped webhook path must leave it alone: the hourly un1t pass
// places people there (the Cold route already runs reclassifyUn1tBoardNow).
describe('ensureDealForContact — a un1t.online primary is left to the hourly pass (HATCH39)', () => {
  function primaryDb(primary) {
    const reads = []
    const writes = []
    const from = (table) => {
      reads.push(table)
      const c = {}
      c.select = () => c; c.eq = () => c; c.order = () => c; c.limit = () => c; c.single = () => c; c.maybeSingle = () => c; c.in = () => c
      c.update = () => { writes.push(table); return c }
      c.insert = () => { writes.push(table); return c }
      c.then = (resolve) => resolve({
        data: table === 'pipelines' ? [primary] : table === 'pipeline_stages' ? [{ id: 's-dormant', slug: 'dormant' }] : [],
        error: null,
      })
      return c
    }
    return { db: { from }, reads, writes }
  }
  it('a derived primary whose module reads un1t.online → leave, with no deals read or write', async () => {
    const { db, reads, writes } = primaryDb({ id: 'p-h-acq', mode: 'derived', module: 'acquisition_un1t' })
    const out = await ensureDealForContact(db, 'hatch', 'c1', { glofox_membership_status: 'lead' }, 'Lead')
    expect(out).toEqual({ action: 'leave', deal_id: null, stage_slug: null, reason: 'un1t_board' })
    expect(reads.filter((t) => t === 'deals')).toHaveLength(0)
    expect(writes).toEqual([])
  })
  it('a manual primary is still a plain leave; a Glofox derived primary still places', async () => {
    const manual = await ensureDealForContact(primaryDb({ id: 'p-wait', mode: 'manual', module: null }).db, 'hatch', 'c1', {}, 'Lead')
    expect(manual).toEqual({ action: 'leave', deal_id: null, stage_slug: null })
    const glofox = await ensureDealForContact(primaryDb({ id: 'p-acq', mode: 'derived', module: 'acquisition' }).db, 'still', 'c1', {}, 'Lead')
    expect(glofox.action).toBe('create')
  })
  it('pre-loaded boards (opts.boards) are judged the same way', async () => {
    const { db, writes } = primaryDb({ id: 'p-h-acq', mode: 'derived', module: 'acquisition_un1t' })
    const boards = [{ id: 'p-h-acq', key: 'acquisition', module: 'acquisition_un1t', mode: 'derived', enabled: true, is_primary: true }]
    const out = await ensureDealForContact(db, 'hatch', 'c1', {}, 'Lead', { boards, claims: { paid: null, programme: null } })
    expect(out).toMatchObject({ action: 'leave', reason: 'un1t_board' })
    expect(writes).toEqual([])
  })
})
