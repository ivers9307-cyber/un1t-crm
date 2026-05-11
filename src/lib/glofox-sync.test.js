import { describe, it, expect } from 'vitest'
import { mapGlofoxMember, mapMembershipStatus, previewMemberSync } from './glofox-sync.js'

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
  }

  it('extracts the right fields', () => {
    const out = mapGlofoxMember(realPayload)
    expect(out.glofox_member_id).toBe('6a01e48ba3409d706800d9f8')
    expect(out.email).toBe('roisinled@hotmail.com')
    expect(out.first_name).toBe('Roisin')
    expect(out.last_name).toBe('Leddy')
    expect(out.phone).toBe('07310018668')
    expect(out.name).toBe('Roisin Leddy')
  })

  it('captures TRIAL as the membership status (NOT lead)', () => {
    // Regression guard for the GLOFOX2.1.1 fix — pre-fix this
    // payload mapped to 'lead' because the parser only checked
    // membership.status / active_membership.status.
    expect(mapGlofoxMember(realPayload).glofox_membership_status).toBe('trial')
  })
})

// previewMemberSync exercises the match-or-create branches via a
// fluent fake of the Supabase query builder. Each db.from(...) call
// returns the same `chain` proxy with .select / .eq / .limit
// methods that record state and end with a Promise of { data }.
function fakeDb({ rowsByGlofoxId = [], rowsByEmail = [] } = {}) {
  // Mode is PER CHAIN — both lookups fire in parallel, so a shared
  // outer-scope `mode` would race and both queries would see the
  // last-written value when their .then() resolved.
  function chain() {
    let mode = null
    const c = {}
    c.select = () => c
    c.eq = (col) => {
      if (col === 'glofox_member_id') mode = 'glofox'
      if (col === 'email')            mode = 'email'
      return c
    }
    c.limit = () => c
    c.then = (resolve) => {
      const data = mode === 'glofox' ? rowsByGlofoxId : mode === 'email' ? rowsByEmail : []
      resolve({ data })
    }
    return c
  }
  return { from: () => chain() }
}

describe('previewMemberSync', () => {
  const member = { _id: 'g1', email: 'me@x.com', first_name: 'Me', last_name: 'You', phone: '+353871234567' }

  it('returns invalid when payload has no _id', async () => {
    const out = await previewMemberSync(fakeDb(), 'loc', { email: 'me@x.com' })
    expect(out.action).toBe('invalid')
  })

  it('returns create when nothing matches', async () => {
    const out = await previewMemberSync(fakeDb(), 'loc', member)
    expect(out.action).toBe('create')
    expect(out.changes.glofox_member_id.to).toBe('g1')
    expect(out.changes.lead_source.to).toBe('glofox')
  })

  it('returns update when only glofox_member_id matches', async () => {
    const existing = { id: 'c1', email: 'me@x.com', first_name: null, last_name: null, phone: null, glofox_member_id: 'g1', glofox_membership_status: null }
    const out = await previewMemberSync(
      fakeDb({ rowsByGlofoxId: [existing], rowsByEmail: [existing] }),
      'loc',
      member,
    )
    expect(out.action).toBe('update')
    expect(out.existing_id).toBe('c1')
    // CRM had nulls, so seed fields propose changes
    expect(out.changes.first_name.to).toBe('Me')
    expect(out.changes.last_name.to).toBe('You')
    expect(out.changes.phone.to).toBe('+353871234567')
  })

  it('returns update when only email matches (link to existing CRM contact)', async () => {
    const existing = { id: 'c2', email: 'me@x.com', first_name: 'Existing', last_name: 'Name', phone: '+353000', glofox_member_id: null, glofox_membership_status: null }
    const out = await previewMemberSync(
      fakeDb({ rowsByGlofoxId: [], rowsByEmail: [existing] }),
      'loc',
      member,
    )
    expect(out.action).toBe('update')
    expect(out.existing_id).toBe('c2')
    expect(out.changes.glofox_member_id.to).toBe('g1')
    // Operator-edited fields not clobbered
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
