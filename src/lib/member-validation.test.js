// Tests for src/lib/member-validation.js (mig 084).

import { describe, it, expect, vi } from 'vitest'
import { validateMemberByEmail, validateTeamRoster, computeTeamPricing, memberLocationIdsFor } from './member-validation'
import { ilikeMatches } from './like-escape.test-helpers'

// ─── computeTeamPricing — pure pricing logic ─────────────────────

describe('computeTeamPricing', () => {
  it('charges everyone non-member fee when pricing is off', () => {
    const result = computeTeamPricing({
      validatedRoster: [
        { is_member: true },
        { is_member: false },
      ],
      race: { member_pricing_enabled: false, member_fee_cents: 1500, non_member_fee_cents: 2500 },
    })
    expect(result.total_cents).toBe(5000) // 2 × 2500
    expect(result.member_count).toBe(0)
    expect(result.non_member_count).toBe(2)
    expect(result.team_composition).toBe('all_non_members')
  })

  it('charges per-head when pricing is enabled (mixed team)', () => {
    const result = computeTeamPricing({
      validatedRoster: [
        { is_member: true },
        { is_member: true },
        { is_member: false },
        { is_member: false },
      ],
      race: { member_pricing_enabled: true, member_fee_cents: 1500, non_member_fee_cents: 2500 },
    })
    expect(result.total_cents).toBe(2 * 1500 + 2 * 2500)
    expect(result.member_count).toBe(2)
    expect(result.non_member_count).toBe(2)
    expect(result.team_composition).toBe('mixed')
  })

  it('all-members team', () => {
    const result = computeTeamPricing({
      validatedRoster: [
        { is_member: true },
        { is_member: true },
      ],
      race: { member_pricing_enabled: true, member_fee_cents: 1500, non_member_fee_cents: 2500 },
    })
    expect(result.total_cents).toBe(3000)
    expect(result.team_composition).toBe('all_members')
  })

  it('all-non-members team', () => {
    const result = computeTeamPricing({
      validatedRoster: [
        { is_member: false },
        { is_member: false },
      ],
      race: { member_pricing_enabled: true, member_fee_cents: 1500, non_member_fee_cents: 2500 },
    })
    expect(result.total_cents).toBe(5000)
    expect(result.team_composition).toBe('all_non_members')
  })

  it('null member_fee = members enter free', () => {
    const result = computeTeamPricing({
      validatedRoster: [
        { is_member: true },
        { is_member: true },
        { is_member: false },
      ],
      race: { member_pricing_enabled: true, member_fee_cents: null, non_member_fee_cents: 2500 },
    })
    expect(result.total_cents).toBe(2500) // only the non-member pays
  })

  it('null non_member_fee = race is free for everyone', () => {
    const result = computeTeamPricing({
      validatedRoster: [
        { is_member: false },
        { is_member: false },
      ],
      race: { member_pricing_enabled: false, member_fee_cents: null, non_member_fee_cents: null },
    })
    expect(result.total_cents).toBe(0)
  })

  it('empty roster yields zero', () => {
    const result = computeTeamPricing({
      validatedRoster: [],
      race: { member_pricing_enabled: true, member_fee_cents: 1500, non_member_fee_cents: 2500 },
    })
    expect(result.total_cents).toBe(0)
    expect(result.team_composition).toBe('all_non_members')
  })

  // Mig 122 (E6 of events expansion): pricing math must be
  // indifferent to event kind. A workshop with 2 members + 1 non-
  // member should produce the same totals as a race with the same
  // roster + the same fee structure. The function reads only
  // member_pricing_enabled / member_fee_cents / non_member_fee_cents
  // off the race object — kind isn't accessed and shouldn't be — so
  // this test guards against any future regression that would
  // accidentally introduce a per-kind pricing branch.
  it('is indifferent to event kind (race vs workshop vs masterclass)', () => {
    const roster = [
      { is_member: true },
      { is_member: true },
      { is_member: false },
    ]
    const fees = { member_pricing_enabled: true, member_fee_cents: 1500, non_member_fee_cents: 2500 }

    const expected = 2 * 1500 + 1 * 2500

    for (const kind of ['race', 'workshop', 'seminar', 'open_day', 'masterclass']) {
      const r = computeTeamPricing({
        validatedRoster: roster,
        race: { ...fees, kind },
      })
      expect(r.total_cents, `kind=${kind} total_cents`).toBe(expected)
      expect(r.member_count, `kind=${kind} member_count`).toBe(2)
      expect(r.non_member_count, `kind=${kind} non_member_count`).toBe(1)
      expect(r.team_composition, `kind=${kind} composition`).toBe('mixed')
    }
  })
})

// ─── validateMemberByEmail — DB-shape lookup ─────────────────────

// A table-aware supabase shim: holds real rows and applies eq/in/ilike the
// way Postgres does (ilike via ilikeMatches, so a LIKE pattern really
// decides what comes back). Terminal calls: .maybeSingle(), .limit(),
// or awaiting the builder itself.
const LOCATIONS = [
  { id: 'loc-1', organization_id: 'org-1', is_host_anchor: false }, // Stillorgan
  { id: 'loc-2', organization_id: 'org-1', is_host_anchor: false }, // Hatch Street
  { id: 'loc-host', organization_id: 'org-1', is_host_anchor: true }, // a host's anchor
  { id: 'loc-other', organization_id: 'org-2', is_host_anchor: false }, // another tenant
]

function fakeDb({ contacts = [], locations = LOCATIONS, memberships = [], errors = {} } = {}) {
  // ORGCONTACTS.2 — `memberships` are contact_studios rows ({ contact_id, location_id, kind, status })
  const tables = { contacts, locations, contact_studios: memberships }
  const db = {
    from: vi.fn((table) => {
      let rows = [...(tables[table] || [])]
      const result = () => (errors[table] ? { data: null, error: errors[table] } : { data: rows, error: null })
      const q = {
        select() { return q },
        eq(col, val) { rows = rows.filter((r) => r[col] === val); return q },
        in(col, vals) { rows = rows.filter((r) => vals.includes(r[col])); return q },
        ilike(col, val) { rows = rows.filter((r) => ilikeMatches(val, r[col])); return q },
        order() { return q },
        range(from, to) { rows = rows.slice(from, to + 1); return q },
        limit: async (n) => {
          const r = result()
          return r.error ? r : { data: rows.slice(0, n), error: null }
        },
        maybeSingle: async () => {
          const r = result()
          if (r.error) return r
          return rows.length > 1 ? { data: null, error: { code: 'PGRST116' } } : { data: rows[0] || null, error: null }
        },
        then: (res, rej) => Promise.resolve(result()).then(res, rej),
      }
      return q
    }),
  }
  return db
}

const contact = (over) => ({ location_id: 'loc-1', email: 'x@example.com', ...over })

describe('validateMemberByEmail', () => {
  it('returns is_member=true when contact has pipeline_stage_slug=member', async () => {
    const db = fakeDb({
      contacts: [contact({ id: 'c-1', email: 'sarah@example.com', first_name: 'Sarah', name: 'Sarah Doe', pipeline_stage_slug: 'member' })],
    })
    const r = await validateMemberByEmail({ db, email: 'sarah@example.com', locationId: 'loc-1' })
    expect(r.is_member).toBe(true)
    expect(r.contact_id).toBe('c-1')
    expect(r.first_name).toBe('Sarah')
    expect(r.status).toBe('verified')
  })

  it('returns is_member=true for a recently converted member (FUNNEL.1 converted stage)', async () => {
    const db = fakeDb({
      contacts: [contact({ id: 'c-3', email: 'cara@example.com', first_name: 'Cara', name: 'Cara New', pipeline_stage_slug: 'converted' })],
    })
    const r = await validateMemberByEmail({ db, email: 'cara@example.com', locationId: 'loc-1' })
    expect(r.is_member).toBe(true)
    expect(r.status).toBe('verified')
  })

  it('returns is_member=false when contact exists but is not a member', async () => {
    const db = fakeDb({
      contacts: [contact({ id: 'c-2', email: 'bob@example.com', first_name: 'Bob', name: 'Bob Smith', pipeline_stage_slug: 'first_class' })],
    })
    const r = await validateMemberByEmail({ db, email: 'bob@example.com', locationId: 'loc-1' })
    expect(r.is_member).toBe(false)
    expect(r.status).toBe('failed')
  })

  it('returns is_member=false when no contact found', async () => {
    const db = fakeDb({ contacts: [] })
    const r = await validateMemberByEmail({ db, email: 'unknown@example.com', locationId: 'loc-1' })
    expect(r.is_member).toBe(false)
    expect(r.status).toBe('failed')
  })

  it('rejects empty / malformed email without DB call', async () => {
    const db = fakeDb({})
    const r1 = await validateMemberByEmail({ db, email: '', locationId: 'loc-1' })
    expect(r1.is_member).toBe(false)
    const r2 = await validateMemberByEmail({ db, email: 'no-at-sign', locationId: 'loc-1' })
    expect(r2.is_member).toBe(false)
    expect(db.from).not.toHaveBeenCalled()
  })

  it('rejects when locationId missing', async () => {
    const db = fakeDb({})
    const r = await validateMemberByEmail({ db, email: 'x@y.com', locationId: null })
    expect(r.is_member).toBe(false)
    expect(db.from).not.toHaveBeenCalled()
  })

  it('returns failed on DB error (fails closed)', async () => {
    const db = fakeDb({ contacts: [], errors: { contacts: { message: 'oops' } } })
    const r = await validateMemberByEmail({ db, email: 'x@y.com', locationId: 'loc-1' })
    expect(r.is_member).toBe(false)
    expect(r.status).toBe('failed')
  })
})

// ─── EVENT-MEMBER-ORG.1 — membership spans the organisation's studios ──
// Every UN1T member's contact lives on Stillorgan (loc-1); a Hatch Street
// (loc-2) event checked only loc-2 and charged every member full price.

describe('validateMemberByEmail — organisation-wide membership', () => {
  const stillorganMember = contact({ id: 'c-m', email: 'm@example.com', first_name: 'Mo', location_id: 'loc-1', pipeline_stage_slug: 'member' })

  it('a Stillorgan member verifies on an event owned by Hatch Street', async () => {
    const db = fakeDb({ contacts: [stillorganMember] })
    const r = await validateMemberByEmail({ db, email: 'm@example.com', locationId: 'loc-2' })
    expect(r.is_member).toBe(true)
    expect(r.contact_id).toBe('c-m')
  })

  it('a member of ANOTHER organisation never verifies', async () => {
    const db = fakeDb({ contacts: [{ ...stillorganMember, location_id: 'loc-other' }] })
    const r = await validateMemberByEmail({ db, email: 'm@example.com', locationId: 'loc-2' })
    expect(r.is_member).toBe(false)
  })

  it('a contact on a host-anchor location does not count as a studio member', async () => {
    const db = fakeDb({ contacts: [{ ...stillorganMember, location_id: 'loc-host' }] })
    const r = await validateMemberByEmail({ db, email: 'm@example.com', locationId: 'loc-2' })
    expect(r.is_member).toBe(false)
  })

  it('an event owned by a host anchor keeps the single-location scope', async () => {
    const db = fakeDb({ contacts: [stillorganMember] })
    const r = await validateMemberByEmail({ db, email: 'm@example.com', locationId: 'loc-host' })
    expect(r.is_member).toBe(false)
  })

  it('an unreadable event location falls back to that location alone, never to nothing', async () => {
    const db = fakeDb({ contacts: [stillorganMember], errors: { locations: { message: 'down' } } })
    expect((await validateMemberByEmail({ db, email: 'm@example.com', locationId: 'loc-1' })).is_member).toBe(true)
    expect((await validateMemberByEmail({ db, email: 'm@example.com', locationId: 'loc-2' })).is_member).toBe(false)
  })

  it('a case-variant duplicate does not hide the member row', async () => {
    const db = fakeDb({
      contacts: [
        contact({ id: 'c-lead', email: 'M@Example.com', location_id: 'loc-2', pipeline_stage_slug: 'lead' }),
        stillorganMember,
      ],
    })
    const r = await validateMemberByEmail({ db, email: 'm@example.com', locationId: 'loc-2' })
    expect(r.is_member).toBe(true)
    expect(r.contact_id).toBe('c-m')
  })

  it('memberLocationIdsFor lists the org studios, never host anchors or other orgs', async () => {
    const ids = await memberLocationIdsFor(fakeDb({}), 'loc-2')
    expect(ids.sort()).toEqual(['loc-1', 'loc-2'])
  })
})

// ─── LIKE wildcards in the public member check (2026-08-07) ──────
// validateMemberByEmail backs the PUBLIC check-member and register routes, so
// `email` is untrusted. The lookup used a bare .ilike(), which matched a
// PATTERN — turning the "is this address a member?" question into "is ANY
// address matching this pattern a member?", and handing back that member's
// contact_id and first_name. See src/lib/like-escape.js.
//
// fakeDb applies ilike the way Postgres does, so the pattern actually
// decides what comes back. Since EVENT-MEMBER-ORG.1 the lookup reads up to
// 10 rows instead of .maybeSingle(), so these tests (not a PGRST116 error)
// are what stop a pattern verifying as somebody else.

const MEMBERS = [
  { id: 'c-axb', location_id: 'loc-1', email: 'axb@example.com', first_name: 'Alex', name: 'Alex B', pipeline_stage_slug: 'member' },
  { id: 'c-underscore', location_id: 'loc-1', email: 'a_b@example.com', first_name: 'Ada', name: 'Ada B', pipeline_stage_slug: 'member' },
  { id: 'c-solo', location_id: 'loc-1', email: 'solo@example.com', first_name: 'Sol', name: 'Sol O', pipeline_stage_slug: 'member' },
]

describe('validateMemberByEmail — LIKE wildcards cannot impersonate a member', () => {
  it('an address containing "_" does not verify against a DIFFERENT member', async () => {
    // Only the lookalike is on file. 'a_b@example.com' must NOT verify as Alex.
    const db = fakeDb({ contacts: [MEMBERS[0]] })
    const r = await validateMemberByEmail({ db, email: 'a_b@example.com', locationId: 'loc-1' })
    expect(r.is_member).toBe(false)
    expect(r.contact_id).toBeNull()
    expect(r.first_name).toBeNull()
  })

  it('"%@domain" does not verify as a member at that domain', async () => {
    const db = fakeDb({ contacts: MEMBERS })
    const r = await validateMemberByEmail({ db, email: '%@example.com', locationId: 'loc-1' })
    expect(r.is_member).toBe(false)
    expect(r.first_name).toBeNull()
  })

  it('"%@%.%" does not verify against the whole table', async () => {
    const db = fakeDb({ contacts: MEMBERS })
    const r = await validateMemberByEmail({ db, email: '%@%.%', locationId: 'loc-1' })
    expect(r.is_member).toBe(false)
  })

  it('still verifies the real owner of an underscored address', async () => {
    const db = fakeDb({ contacts: MEMBERS })
    const r = await validateMemberByEmail({ db, email: 'a_b@example.com', locationId: 'loc-1' })
    expect(r.is_member).toBe(true)
    expect(r.contact_id).toBe('c-underscore')
    expect(r.first_name).toBe('Ada')
  })

  it('still verifies a mixed-case address (escaping is behaviour-preserving)', async () => {
    const db = fakeDb({ contacts: [{ ...MEMBERS[2], email: 'Solo@Example.COM' }] })
    const r = await validateMemberByEmail({ db, email: 'solo@example.com', locationId: 'loc-1' })
    expect(r.is_member).toBe(true)
    expect(r.contact_id).toBe('c-solo')
  })
})

// ─── validateTeamRoster ──────────────────────────────────────────

describe('validateTeamRoster', () => {
  it('marks members with no email as not_applicable', async () => {
    const db = fakeDb({})
    const r = await validateTeamRoster({
      db,
      members: [{ name: 'Alice', email: null }],
      locationId: 'loc-1',
    })
    expect(r[0].is_member).toBe(false)
    expect(r[0].status).toBe('not_applicable')
  })
})

describe('validateTeamRoster — organisation scope', () => {
  it('resolves the org studios once for the whole roster', async () => {
    const db = fakeDb({
      contacts: [
        { id: 'c-a', location_id: 'loc-1', email: 'a@example.com', first_name: 'A', pipeline_stage_slug: 'member' },
      ],
    })
    const r = await validateTeamRoster({
      db,
      members: [{ name: 'A', email: 'a@example.com' }, { name: 'B', email: 'b@example.com' }],
      locationId: 'loc-2',
    })
    expect(r.map((m) => m.is_member)).toEqual([true, false])
    expect(db.from.mock.calls.filter(([t]) => t === 'locations')).toHaveLength(2) // own row + siblings, once
  })
})

// ─── HATCH-MEMBERS.1 — memberships held outside Glofox (mig 722) ──
// Hatch Street sells on un1t.online; its members sit on the manual Waitlist
// board, so their stage never says 'member'. An active contact_memberships
// row is the signal.

describe('validateMemberByEmail — contact_studios member rows (ORGCONTACTS.2)', () => {
  const hatchLead = { id: 'c-h', location_id: 'loc-2', email: 'h@example.com', first_name: 'Hana', pipeline_stage_slug: 'waitlist_new_enquiry' }
  const active = { contact_id: 'c-h', location_id: 'loc-2', kind: 'member', status: 'active' }

  it('an active Hatch membership verifies on a Hatch event and a Stillorgan event', async () => {
    for (const locationId of ['loc-2', 'loc-1']) {
      const db = fakeDb({ contacts: [hatchLead], memberships: [active] })
      const r = await validateMemberByEmail({ db, email: 'h@example.com', locationId })
      expect(r).toMatchObject({ is_member: true, contact_id: 'c-h', first_name: 'Hana' })
    }
  })

  it('an ended membership does not; nor does a client or lead relationship', async () => {
    const db = fakeDb({ contacts: [hatchLead], memberships: [{ ...active, status: 'ended' }] })
    expect((await validateMemberByEmail({ db, email: 'h@example.com', locationId: 'loc-2' })).is_member).toBe(false)
    const client = fakeDb({ contacts: [hatchLead], memberships: [{ ...active, kind: 'client' }] })
    expect((await validateMemberByEmail({ db: client, email: 'h@example.com', locationId: 'loc-2' })).is_member).toBe(false)
  })

  it('a membership at another organisation\'s studio does not', async () => {
    const db = fakeDb({ contacts: [hatchLead], memberships: [{ ...active, location_id: 'loc-other' }] })
    expect((await validateMemberByEmail({ db, email: 'h@example.com', locationId: 'loc-2' })).is_member).toBe(false)
  })

  it('an unreadable memberships table falls back to the stage check, never throws', async () => {
    const db = fakeDb({ contacts: [hatchLead], memberships: [active], errors: { contact_studios: { message: 'down' } } })
    expect((await validateMemberByEmail({ db, email: 'h@example.com', locationId: 'loc-2' })).is_member).toBe(false)
  })

  it('a stage member never needs the memberships read', async () => {
    const db = fakeDb({ contacts: [{ ...hatchLead, pipeline_stage_slug: 'member' }] })
    expect((await validateMemberByEmail({ db, email: 'h@example.com', locationId: 'loc-2' })).is_member).toBe(true)
    expect(db.from.mock.calls.some(([t]) => t === 'contact_studios')).toBe(false)
  })

  it('no contact found means no memberships read', async () => {
    const db = fakeDb({ contacts: [], memberships: [active] })
    expect((await validateMemberByEmail({ db, email: 'h@example.com', locationId: 'loc-2' })).is_member).toBe(false)
    expect(db.from.mock.calls.some(([t]) => t === 'contact_studios')).toBe(false)
  })
})
