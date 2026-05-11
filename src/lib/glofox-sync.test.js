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
  it('returns lead when no membership info is present', () => {
    expect(mapMembershipStatus({})).toBe('lead')
    expect(mapMembershipStatus(null)).toBe('lead')
  })

  it('reads top-level status', () => {
    expect(mapMembershipStatus({ status: 'active' })).toBe('active')
  })

  it('reads nested membership.status', () => {
    expect(mapMembershipStatus({ membership: { status: 'paused' } })).toBe('paused')
  })

  it('reads nested active_membership.status', () => {
    expect(mapMembershipStatus({ active_membership: { status: 'cancelled' } })).toBe('cancelled')
  })

  it('lowercases + trims', () => {
    expect(mapMembershipStatus({ status: '  EXPIRED  ' })).toBe('expired')
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
