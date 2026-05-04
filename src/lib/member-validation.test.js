// Tests for src/lib/member-validation.js (mig 084).

import { describe, it, expect, vi } from 'vitest'
import { validateMemberByEmail, validateTeamRoster, computeTeamPricing } from './member-validation'

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
  it('returns is_member=true when contact has lead_status=member', async () => {
    const db = mockDb({
      contact: { id: 'c-1', first_name: 'Sarah', name: 'Sarah Doe', lead_status: 'member' },
    })
    const r = await validateMemberByEmail({ db, email: 'sarah@example.com', locationId: 'loc-1' })
    expect(r.is_member).toBe(true)
    expect(r.contact_id).toBe('c-1')
    expect(r.first_name).toBe('Sarah')
    expect(r.status).toBe('verified')
  })

  it('returns is_member=false when contact exists but is not a member', async () => {
    const db = mockDb({
      contact: { id: 'c-2', first_name: 'Bob', name: 'Bob Smith', lead_status: 'active_trial' },
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
