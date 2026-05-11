import { describe, it, expect } from 'vitest'
import {
  mapGlofoxMember,
  mapMembershipStatus,
  previewMemberSync,
  parseGlofoxDate,
  normalizePhone,
  mapGlofoxSource,
  pipelineStageSlugForStatus,
  targetDealStageForSync,
} from './glofox-sync.js'

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

  // GLOFOX2.1.7 — Credit Member detection.
  //
  // UN1T "Credit Members" buy class packs directly (membership.type
  // = 'num_classes') instead of taking out a subscription. Glofox
  // tags them as lead_status='MEMBER' (correct — they pay) but
  // operationally they need their own audience for upsell-to-
  // subscription marketing.
  it('detects Credit Member (active) → credit_member', () => {
    expect(mapMembershipStatus({
      lead_status: 'MEMBER',
      membership: { type: 'num_classes' },
      active: true,
    })).toBe('credit_member')
  })

  it('collapses inactive Credit Member into ex_member', () => {
    expect(mapMembershipStatus({
      lead_status: 'MEMBER',
      membership: { type: 'num_classes' },
      active: false,
    })).toBe('ex_member')
  })

  it('Credit Member detection takes precedence over plain MEMBER mapping', () => {
    // Without the synthesis they'd fall through to 'member' (the
    // subscription canonical) and get lumped in with monthly
    // recurring customers.
    const out = mapMembershipStatus({
      lead_status: 'MEMBER',
      membership: { type: 'num_classes' },
      active: true,
    })
    expect(out).not.toBe('member')
    expect(out).toBe('credit_member')
  })

  it('does NOT trigger Credit Member detection without lead_status=MEMBER', () => {
    // A trial user on a num_classes pack (e.g., the 3-class trial)
    // should map by lead_status, not promote to credit_member.
    expect(mapMembershipStatus({
      lead_status: 'TRIAL',
      membership: { type: 'num_classes' },
      active: true,
    })).toBe('trial')
  })

  it('does NOT trigger Credit Member detection for a subscription MEMBER', () => {
    // A real subscription member must NOT get reclassified.
    expect(mapMembershipStatus({
      lead_status: 'MEMBER',
      membership: { type: 'subscription' },
      active: true,
    })).toBe('member')
    expect(mapMembershipStatus({
      lead_status: 'MEMBER',
      membership: { type: 'recurring' },
      active: true,
    })).toBe('member')
  })

  it('Credit Member detection is case-insensitive on type', () => {
    expect(mapMembershipStatus({
      lead_status: 'member',
      membership: { type: 'NUM_CLASSES' },
      active: true,
    })).toBe('credit_member')
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
  it('maps known Glofox sources to leadSourceSchema enum values', () => {
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
})

// GLOFOX2.1.7 — Credit Member (real payload).
// Gillian Collins from the live UN1T Stillorgan dry-run. Glofox
// tags her lead_status='MEMBER' because she pays, but her
// membership.type='num_classes' reveals she bought a class pack
// rather than a subscription — a "Credit Member" in UN1T parlance.
describe('mapGlofoxMember (real Glofox payload — Credit Member)', () => {
  const gillianPayload = {
    _id: '69f1319ff6d376b55a0b8add',
    branch_id: '6155764859810329ec3826b3',
    namespace: 'untstillorgan',
    membership: {
      _id: '620bdab4df0f8054814cd7be',
      type: 'num_classes',
      plan_price: 0,
      trial: true,
      membership_name: '1) The UN1T Trial',
      description: '3  Classes - 7 Day Expiry',
      membership_plan_name: 'The UN1T Trial',
    },
    first_name: 'Gillian',
    last_name: 'Collins',
    phone: '0871359761',
    email: 'gillianpcollins@gmail.com',
    birth: null,
    type: 'member',
    active: true,
    lead_status: 'MEMBER',
    leads: { status: 'MEMBER' },
    source: 'WEBPORTAL',
    MEMBERPURCHASE: true,
    PAYGPAYMENT: true,
    name: 'Gillian Collins',
    role: 'member',
  }

  it('detects Credit Member via lead_status=MEMBER + membership.type=num_classes', () => {
    expect(mapGlofoxMember(gillianPayload).glofox_membership_status).toBe('credit_member')
  })

  it('does NOT collapse to plain "member" canonical', () => {
    // Regression guard — without the credit_member synthesis Gillian
    // would land in the 'member' stage alongside monthly subscribers.
    expect(mapGlofoxMember(gillianPayload).glofox_membership_status).not.toBe('member')
  })

  it('normalises Irish 08X mobile to +353', () => {
    expect(mapGlofoxMember(gillianPayload).phone).toBe('+353871359761')
  })

  it('maps WEBPORTAL source to website lead_source', () => {
    expect(mapGlofoxMember(gillianPayload).lead_source).toBe('website')
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
  const member = { _id: 'g1', email: 'me@x.com', first_name: 'Me', last_name: 'You', phone: '+353871234567' }

  it('returns invalid when payload has no _id', async () => {
    const out = await previewMemberSync(fakeDb(), 'loc', { email: 'me@x.com' })
    expect(out.action).toBe('invalid')
  })

  it('returns create when nothing matches + proposes a deal', async () => {
    const out = await previewMemberSync(fakeDb(), 'loc', member)
    expect(out.action).toBe('create')
    expect(out.changes.glofox_member_id.to).toBe('g1')
    expect(out.changes.lead_source.to).toBe('other')
    expect(out.deal_action).toEqual({ action: 'create', stage_slug: 'new_lead' })
  })

  it('proposes trial_active stage when Glofox status is trial', async () => {
    const m = { ...member, lead_status: 'TRIAL' }
    const out = await previewMemberSync(fakeDb(), 'loc', m)
    expect(out.deal_action).toEqual({ action: 'create', stage_slug: 'trial_active' })
  })

  it('uses mapped lead_source when Glofox source is supplied', async () => {
    const m = { ...member, source: 'WEBPORTAL' }
    const out = await previewMemberSync(fakeDb(), 'loc', m)
    expect(out.changes.lead_source.to).toBe('website')
  })

  it('proposes create when contact exists but has no open deal (Roisin backfill)', async () => {
    const existing = { id: 'c1', email: 'me@x.com', first_name: null, last_name: null, phone: null, glofox_member_id: 'g1', glofox_membership_status: null }
    const out = await previewMemberSync(
      fakeDb({ rowsByGlofoxId: [existing], rowsByEmail: [existing], openDeal: null }),
      'loc',
      member,
    )
    expect(out.action).toBe('update')
    expect(out.deal_action.action).toBe('create')
    expect(out.deal_action.stage_slug).toBe('new_lead')
  })

  it('proposes leave when status unchanged AND deal already at target', async () => {
    const existing = { id: 'c1', email: 'me@x.com', glofox_member_id: 'g1', glofox_membership_status: 'trial' }
    const out = await previewMemberSync(
      fakeDb({
        rowsByGlofoxId: [existing], rowsByEmail: [existing],
        openDeal: { id: 'd1', stage_id: 's1', stage_slug: 'trial_active' },
      }),
      'loc',
      { ...member, lead_status: 'TRIAL' },
    )
    expect(out.deal_action.action).toBe('leave')
    expect(out.deal_action.reason).toMatch(/no Glofox status change/)
  })

  it('proposes move when trial → no_sale_trial (chase the trialist)', async () => {
    const existing = { id: 'c1', email: 'me@x.com', glofox_member_id: 'g1', glofox_membership_status: 'trial' }
    const out = await previewMemberSync(
      fakeDb({
        rowsByGlofoxId: [existing], rowsByEmail: [existing],
        openDeal: { id: 'd1', stage_id: 's1', stage_slug: 'trial_active' },
      }),
      'loc',
      { ...member, lead_status: 'NO_SALE_TRIAL' },
    )
    expect(out.deal_action).toMatchObject({
      action: 'move', from_slug: 'trial_active', to_slug: 'follow_up_needed',
      previous_status: 'trial', new_status: 'no_sale_trial',
    })
  })

  it('proposes move when MEMBER + active:false (ex_member → lost_member)', async () => {
    const existing = { id: 'c1', email: 'me@x.com', glofox_member_id: 'g1', glofox_membership_status: 'member' }
    const out = await previewMemberSync(
      fakeDb({
        rowsByGlofoxId: [existing], rowsByEmail: [existing],
        openDeal: { id: 'd1', stage_id: 's1', stage_slug: 'member' },
      }),
      'loc',
      { ...member, lead_status: 'MEMBER', active: false },
    )
    expect(out.deal_action).toMatchObject({
      action: 'move', from_slug: 'member', to_slug: 'lost_member',
      previous_status: 'member', new_status: 'ex_member',
    })
  })

  it('proposes leave when status changed but deal sits in operator-only stage', async () => {
    // Operator manually placed the deal in returning_member (a
    // pure operator-managed slot). Glofox status changes — still
    // hands off; respect the manual placement.
    const existing = { id: 'c1', email: 'me@x.com', glofox_member_id: 'g1', glofox_membership_status: 'member' }
    const out = await previewMemberSync(
      fakeDb({
        rowsByGlofoxId: [existing], rowsByEmail: [existing],
        openDeal: { id: 'd1', stage_id: 's1', stage_slug: 'returning_member' },
      }),
      'loc',
      { ...member, lead_status: 'MEMBER', active: false },
    )
    expect(out.deal_action.action).toBe('leave')
    expect(out.deal_action.reason).toMatch(/operator-only/)
  })

  it('proposes leave when operator manually moved a member deal to follow_up_needed and status is unchanged', async () => {
    // Real-world case: member is being chased for renewal — operator
    // moved the deal to follow_up_needed. Re-syncing must NOT pull
    // them back to 'member'. The status-change guard handles this.
    const existing = { id: 'c1', email: 'me@x.com', glofox_member_id: 'g1', glofox_membership_status: 'member' }
    const out = await previewMemberSync(
      fakeDb({
        rowsByGlofoxId: [existing], rowsByEmail: [existing],
        openDeal: { id: 'd1', stage_id: 's1', stage_slug: 'follow_up_needed' },
      }),
      'loc',
      { ...member, lead_status: 'MEMBER', active: true },
    )
    expect(out.deal_action.action).toBe('leave')
    expect(out.deal_action.reason).toMatch(/no Glofox status change/)
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

  it('routes credit_member → member when Credit Member takes a subscription', () => {
    // The operator's primary win for Credit Members — recurring
    // revenue beats one-off pack purchases. Move from credit_member
    // straight to member.
    expect(targetDealStageForSync('credit_member', 'member', 'credit_member')).toBe('member')
  })

  it('routes credit_member → ex_member to lost_member (credits ran out, no renewal)', () => {
    expect(targetDealStageForSync('credit_member', 'ex_member', 'credit_member')).toBe('lost_member')
  })

  it('routes trial → credit_member when trialist buys a class pack', () => {
    expect(targetDealStageForSync('trial', 'credit_member', 'trial_active')).toBe('credit_member')
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
