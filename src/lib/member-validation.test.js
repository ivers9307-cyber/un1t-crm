// Tests for src/lib/member-validation.js (mig 084).

import { describe, it, expect, vi } from 'vitest'
import { validateMemberByEmail, validateTeamRoster, computeTeamPricing } from './member-validation'
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

function mockDb({ contact = null, error = null } = {}) {
  // Minimal supabase client shim that returns the configured row.
  const chain = {
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    ilike: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: contact, error }),
  }
  return chain
}

describe('validateMemberByEmail', () => {
  it('returns is_member=true when contact has pipeline_stage_slug=member', async () => {
    const db = mockDb({
      contact: { id: 'c-1', first_name: 'Sarah', name: 'Sarah Doe', pipeline_stage_slug: 'member' },
    })
    const r = await validateMemberByEmail({ db, email: 'sarah@example.com', locationId: 'loc-1' })
    expect(r.is_member).toBe(true)
    expect(r.contact_id).toBe('c-1')
    expect(r.first_name).toBe('Sarah')
    expect(r.status).toBe('verified')
  })

  it('returns is_member=true for a recently converted member (FUNNEL.1 converted stage)', async () => {
    const db = mockDb({
      contact: { id: 'c-3', first_name: 'Cara', name: 'Cara New', pipeline_stage_slug: 'converted' },
    })
    const r = await validateMemberByEmail({ db, email: 'cara@example.com', locationId: 'loc-1' })
    expect(r.is_member).toBe(true)
    expect(r.status).toBe('verified')
  })

  it('returns is_member=false when contact exists but is not a member', async () => {
    const db = mockDb({
      contact: { id: 'c-2', first_name: 'Bob', name: 'Bob Smith', pipeline_stage_slug: 'first_class' },
    })
    const r = await validateMemberByEmail({ db, email: 'bob@example.com', locationId: 'loc-1' })
    expect(r.is_member).toBe(false)
    expect(r.status).toBe('failed')
  })

  it('returns is_member=false when no contact found', async () => {
    const db = mockDb({ contact: null })
    const r = await validateMemberByEmail({ db, email: 'unknown@example.com', locationId: 'loc-1' })
    expect(r.is_member).toBe(false)
    expect(r.status).toBe('failed')
  })

  it('rejects empty / malformed email without DB call', async () => {
    const db = mockDb({})
    const r1 = await validateMemberByEmail({ db, email: '', locationId: 'loc-1' })
    expect(r1.is_member).toBe(false)
    const r2 = await validateMemberByEmail({ db, email: 'no-at-sign', locationId: 'loc-1' })
    expect(r2.is_member).toBe(false)
    expect(db.maybeSingle).not.toHaveBeenCalled()
  })

  it('rejects when locationId missing', async () => {
    const db = mockDb({})
    const r = await validateMemberByEmail({ db, email: 'x@y.com', locationId: null })
    expect(r.is_member).toBe(false)
    expect(db.maybeSingle).not.toHaveBeenCalled()
  })

  it('returns failed on DB error (fails closed)', async () => {
    const db = mockDb({ contact: null, error: { message: 'oops' } })
    const r = await validateMemberByEmail({ db, email: 'x@y.com', locationId: 'loc-1' })
    expect(r.is_member).toBe(false)
    expect(r.status).toBe('failed')
  })
})

// ─── LIKE wildcards in the public member check (2026-08-07) ──────
// validateMemberByEmail backs the PUBLIC check-member and register routes, so
// `email` is untrusted. The lookup used a bare .ilike(), which matched a
// PATTERN — turning the "is this address a member?" question into "is ANY
// address matching this pattern a member?", and handing back that member's
// contact_id and first_name. See src/lib/like-escape.js.
//
// Unlike mockDb above (which returns a fixed row whatever the query), this one
// holds real rows and applies eq/ilike the way Postgres does, so the pattern
// actually decides what comes back.
function mockContactsDb(rows) {
  const q = {
    _rows: rows,
    from() { return q },
    select() { return q },
    eq(col, val) { q._rows = q._rows.filter((r) => r[col] === val); return q },
    ilike(col, val) { q._rows = q._rows.filter((r) => ilikeMatches(val, r[col])); return q },
    // PostgREST .maybeSingle() errors when the filter matched more than one row.
    maybeSingle: async () => (q._rows.length > 1
      ? { data: null, error: { code: 'PGRST116' } }
      : { data: q._rows[0] || null, error: null }),
  }
  return q
}

const MEMBERS = [
  { id: 'c-axb', location_id: 'loc-1', email: 'axb@example.com', first_name: 'Alex', name: 'Alex B', pipeline_stage_slug: 'member' },
  { id: 'c-underscore', location_id: 'loc-1', email: 'a_b@example.com', first_name: 'Ada', name: 'Ada B', pipeline_stage_slug: 'member' },
  { id: 'c-solo', location_id: 'loc-1', email: 'solo@example.com', first_name: 'Sol', name: 'Sol O', pipeline_stage_slug: 'member' },
]

describe('validateMemberByEmail — LIKE wildcards cannot impersonate a member', () => {
  it('an address containing "_" does not verify against a DIFFERENT member', async () => {
    // Only the lookalike is on file. 'a_b@example.com' must NOT verify as Alex.
    const db = mockContactsDb([MEMBERS[0]])
    const r = await validateMemberByEmail({ db, email: 'a_b@example.com', locationId: 'loc-1' })
    expect(r.is_member).toBe(false)
    expect(r.contact_id).toBeNull()
    expect(r.first_name).toBeNull()
  })

  it('"%@domain" does not verify as the one member at that domain', async () => {
    // The enumeration oracle: exactly one member at the domain means
    // .maybeSingle() returns a row rather than erroring, so an unescaped
    // pattern answers is_member: true and leaks their first name.
    const db = mockContactsDb([MEMBERS[2]])
    const r = await validateMemberByEmail({ db, email: '%@example.com', locationId: 'loc-1' })
    expect(r.is_member).toBe(false)
    expect(r.first_name).toBeNull()
  })

  it('"%@%.%" does not verify against the whole table', async () => {
    const db = mockContactsDb([MEMBERS[2]])
    const r = await validateMemberByEmail({ db, email: '%@%.%', locationId: 'loc-1' })
    expect(r.is_member).toBe(false)
  })

  it('still verifies the real owner of an underscored address', async () => {
    const db = mockContactsDb(MEMBERS)
    const r = await validateMemberByEmail({ db, email: 'a_b@example.com', locationId: 'loc-1' })
    expect(r.is_member).toBe(true)
    expect(r.contact_id).toBe('c-underscore')
    expect(r.first_name).toBe('Ada')
  })

  it('still verifies a mixed-case address (escaping is behaviour-preserving)', async () => {
    const db = mockContactsDb([{ ...MEMBERS[2], email: 'Solo@Example.COM' }])
    const r = await validateMemberByEmail({ db, email: 'solo@example.com', locationId: 'loc-1' })
    expect(r.is_member).toBe(true)
    expect(r.contact_id).toBe('c-solo')
  })
})

// ─── validateTeamRoster ──────────────────────────────────────────

describe('validateTeamRoster', () => {
  it('marks members with no email as not_applicable', async () => {
    const db = mockDb({})
    const r = await validateTeamRoster({
      db,
      members: [{ name: 'Alice', email: null }],
      locationId: 'loc-1',
    })
    expect(r[0].is_member).toBe(false)
    expect(r[0].status).toBe('not_applicable')
  })
})
