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

describe('mapMembershipStatus', () => {
  it('returns lead when no membership info AND no active boolean', () => {
    expect(mapMembershipStatus({})).toBe('lead')
    expect(mapMembershipStatus(null)).toBe('lead')
  })

  it('reads top-level lead_status (Glofox primary)', () => {
    // Real Glofox payload puts the membership stage in lead_status
    // (uppercase: TRIAL / ACTIVE / CANCELLED / EXPIRED / LEAD).
    expect(mapMembershipStatus({ lead_status: 'TRIAL' })).toBe('trial')
    expect(mapMembershipStatus({ lead_status: 'ACTIVE' })).toBe('active')
    expect(mapMembershipStatus({ lead_status: 'CANCELLED' })).toBe('cancelled')
  })

  it('reads nested leads.status (Glofox secondary)', () => {
    expect(mapMembershipStatus({ leads: { status: 'TRIAL' } })).toBe('trial')
  })

  it('reads top-level status (alternate shape)', () => {
    expect(mapMembershipStatus({ status: 'active' })).toBe('active')
  })

  it('reads nested membership.status', () => {
    expect(mapMembershipStatus({ membership: { status: 'paused' } })).toBe('paused')
  })

  it('reads nested active_membership.status', () => {
    expect(mapMembershipStatus({ active_membership: { status: 'cancelled' } })).toBe('cancelled')
  })

  it('falls back to active=true → active', () => {
    expect(mapMembershipStatus({ active: true })).toBe('active')
  })

  it('falls back to active=false → inactive', () => {
    expect(mapMembershipStatus({ active: false })).toBe('inactive')
  })

  it('prefers lead_status over the active boolean', () => {
    // A trial member has active: true AND lead_status: TRIAL — we
    // want the more-specific TRIAL, not the generic 'active'.
    expect(mapMembershipStatus({ lead_status: 'TRIAL', active: true })).toBe('trial')
  })

  it('lowercases + trims', () => {
    expect(mapMembershipStatus({ lead_status: '  EXPIRED  ' })).toBe('expired')
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

  it('proposes leave when deal already in target stage', async () => {
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
  })

  it('proposes move when trial → cancelled while deal is in trial_active', async () => {
    const existing = { id: 'c1', email: 'me@x.com', glofox_member_id: 'g1' }
    const out = await previewMemberSync(
      fakeDb({
        rowsByGlofoxId: [existing], rowsByEmail: [existing],
        openDeal: { id: 'd1', stage_id: 's1', stage_slug: 'trial_active' },
      }),
      'loc',
      { ...member, lead_status: 'CANCELLED' },
    )
    expect(out.deal_action).toMatchObject({
      action: 'move', from_slug: 'trial_active', to_slug: 'follow_up_needed',
    })
  })

  it('proposes move when member → cancelled (lost_member)', async () => {
    const existing = { id: 'c1', email: 'me@x.com', glofox_member_id: 'g1' }
    const out = await previewMemberSync(
      fakeDb({
        rowsByGlofoxId: [existing], rowsByEmail: [existing],
        openDeal: { id: 'd1', stage_id: 's1', stage_slug: 'member' },
      }),
      'loc',
      { ...member, lead_status: 'CANCELLED' },
    )
    expect(out.deal_action).toMatchObject({
      action: 'move', from_slug: 'member', to_slug: 'lost_member',
    })
  })

  it('proposes leave when deal in operator-managed stage (e.g. follow_up_needed → cancelled)', async () => {
    const existing = { id: 'c1', email: 'me@x.com', glofox_member_id: 'g1' }
    const out = await previewMemberSync(
      fakeDb({
        rowsByGlofoxId: [existing], rowsByEmail: [existing],
        openDeal: { id: 'd1', stage_id: 's1', stage_slug: 'follow_up_needed' },
      }),
      'loc',
      { ...member, lead_status: 'CANCELLED' },
    )
    expect(out.deal_action.action).toBe('leave')
    expect(out.deal_action.reason).toMatch(/operator-managed/)
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

describe('targetDealStageForSync (GLOFOX2.1.4 transitions)', () => {
  it('promotes trial_active to member when status becomes active', () => {
    expect(targetDealStageForSync('active', 'trial_active')).toBe('member')
    expect(targetDealStageForSync('active', 'new_lead')).toBe('member')
    expect(targetDealStageForSync('active', 'new_lead_social')).toBe('member')
  })

  it('promotes new_lead to trial_active when status becomes trial', () => {
    expect(targetDealStageForSync('trial', 'new_lead')).toBe('trial_active')
    expect(targetDealStageForSync('trial', 'new_lead_social')).toBe('trial_active')
  })

  it('routes member → cancelled to lost_member', () => {
    expect(targetDealStageForSync('cancelled', 'member')).toBe('lost_member')
    expect(targetDealStageForSync('expired', 'member')).toBe('lost_member')
    expect(targetDealStageForSync('inactive', 'member')).toBe('lost_member')
  })

  it('routes trial/lead → cancelled to follow_up_needed', () => {
    expect(targetDealStageForSync('cancelled', 'trial_active')).toBe('follow_up_needed')
    expect(targetDealStageForSync('cancelled', 'new_lead')).toBe('follow_up_needed')
    expect(targetDealStageForSync('cancelled', 'new_lead_social')).toBe('follow_up_needed')
  })

  it('flags paused member as at-risk via follow_up_needed', () => {
    expect(targetDealStageForSync('paused', 'member')).toBe('follow_up_needed')
  })

  it('leaves operator-managed stages alone on cancellation', () => {
    expect(targetDealStageForSync('cancelled', 'follow_up_needed')).toBeNull()
    expect(targetDealStageForSync('cancelled', 'returning_member')).toBeNull()
    expect(targetDealStageForSync('cancelled', 'cold_email_only')).toBeNull()
    expect(targetDealStageForSync('cancelled', 'conversion_ready')).toBeNull()
  })

  it('leaves deals alone on lead / unknown / null status', () => {
    expect(targetDealStageForSync('lead', 'trial_active')).toBeNull()
    expect(targetDealStageForSync('unknown', 'member')).toBeNull()
    expect(targetDealStageForSync(null, 'member')).toBeNull()
  })

  it('is case-insensitive on status', () => {
    expect(targetDealStageForSync('CANCELLED', 'member')).toBe('lost_member')
  })
})

describe('pipelineStageSlugForStatus', () => {
  it('maps Glofox statuses to pipeline_stages slugs', () => {
    expect(pipelineStageSlugForStatus('trial')).toBe('trial_active')
    expect(pipelineStageSlugForStatus('active')).toBe('member')
    expect(pipelineStageSlugForStatus('cancelled')).toBe('lost_member')
    expect(pipelineStageSlugForStatus('expired')).toBe('lost_member')
    expect(pipelineStageSlugForStatus('inactive')).toBe('lost_member')
    expect(pipelineStageSlugForStatus('paused')).toBe('follow_up_needed')
    expect(pipelineStageSlugForStatus('lead')).toBe('new_lead')
  })

  it('is case-insensitive', () => {
    expect(pipelineStageSlugForStatus('TRIAL')).toBe('trial_active')
  })

  it('defaults to new_lead for unknown / missing values', () => {
    expect(pipelineStageSlugForStatus('something_weird')).toBe('new_lead')
    expect(pipelineStageSlugForStatus(null)).toBe('new_lead')
    expect(pipelineStageSlugForStatus(undefined)).toBe('new_lead')
    expect(pipelineStageSlugForStatus('')).toBe('new_lead')
  })
})
