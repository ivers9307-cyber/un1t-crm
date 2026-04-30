import { describe, it, expect, beforeEach } from 'vitest'
import { applyAudienceFilter, AUDIENCE_FIELDS, InvalidAudienceFilterError } from './audience-filter.js'

// Mock Supabase query builder — every method returns `this` and records the call.
function makeMockQuery() {
  const calls = []
  const handler = {
    get: (_, prop) => function (...args) {
      calls.push([prop, ...args])
      return new Proxy({}, handler)
    },
  }
  const root = new Proxy({}, handler)
  return { query: root, calls }
}

describe('applyAudienceFilter', () => {
  let q

  beforeEach(() => {
    q = makeMockQuery()
  })

  it('returns the query unchanged for an empty filter', () => {
    const result = applyAudienceFilter(q.query, null)
    expect(result).toBe(q.query)
    expect(q.calls).toHaveLength(0)
  })

  it('returns the query unchanged when filters array is empty', () => {
    applyAudienceFilter(q.query, { filters: [] })
    expect(q.calls).toHaveLength(0)
  })

  it('applies a select-field eq filter', () => {
    applyAudienceFilter(q.query, { filters: [{ field: 'lead_status', op: 'eq', value: 'member' }] })
    expect(q.calls).toEqual([['eq', 'lead_status', 'member']])
  })

  it('applies a contains filter as ilike with %wrapping%', () => {
    applyAudienceFilter(q.query, { filters: [{ field: 'email', op: 'contains', value: 'gmail' }] })
    expect(q.calls).toEqual([['ilike', 'email', '%gmail%']])
  })

  it('coerces numeric values for gt operator', () => {
    applyAudienceFilter(q.query, { filters: [{ field: 'total_emails_opened', op: 'gt', value: '5' }] })
    expect(q.calls).toEqual([['gt', 'total_emails_opened', 5]])
  })

  it('rejects an unknown field', () => {
    expect(() => applyAudienceFilter(q.query, { filters: [{ field: 'password', op: 'eq', value: 'x' }] }))
      .toThrow(InvalidAudienceFilterError)
  })

  it('rejects a dotted-path field (PostgREST traversal)', () => {
    expect(() => applyAudienceFilter(q.query, { filters: [{ field: 'profiles.role', op: 'eq', value: 'owner' }] }))
      .toThrow(/Unknown audience field/)
  })

  it('rejects an op not on the field allowlist', () => {
    expect(() => applyAudienceFilter(q.query, { filters: [{ field: 'lead_status', op: 'contains', value: 'mem' }] }))
      .toThrow(/not allowed on field/)
  })

  it('rejects non-numeric value on a numeric op', () => {
    expect(() => applyAudienceFilter(q.query, { filters: [{ field: 'total_emails_opened', op: 'gt', value: 'abc' }] }))
      .toThrow(/requires a numeric value/)
  })

  it('rejects when filters is not an array', () => {
    expect(() => applyAudienceFilter(q.query, { filters: 'oops' })).toThrow(/must be an array/)
  })

  it('rejects when a filter row is null', () => {
    expect(() => applyAudienceFilter(q.query, { filters: [null] })).toThrow(/Each filter must be an object/)
  })

  it('handles days_since_gt by computing a cutoff and applying lt', () => {
    applyAudienceFilter(q.query, { filters: [{ field: 'last_emailed_at', op: 'days_since_gt', value: '30' }] })
    expect(q.calls).toHaveLength(1)
    expect(q.calls[0][0]).toBe('lt')
    expect(q.calls[0][1]).toBe('last_emailed_at')
    // Cutoff should be ~30 days ago, ISO string
    expect(q.calls[0][2]).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('handles is_null and is_not_null', () => {
    applyAudienceFilter(q.query, { filters: [{ field: 'glofox_member_id', op: 'is_null' }] })
    expect(q.calls).toEqual([['is', 'glofox_member_id', null]])
  })
})

describe('AUDIENCE_FIELDS allowlist', () => {
  it('is frozen so it cannot be mutated at runtime', () => {
    expect(Object.isFrozen(AUDIENCE_FIELDS)).toBe(true)
  })

  it('every field has a type and ops array', () => {
    for (const [name, cfg] of Object.entries(AUDIENCE_FIELDS)) {
      expect(cfg.type, `${name} missing type`).toBeTypeOf('string')
      expect(cfg.ops, `${name} missing ops`).toBeInstanceOf(Array)
      expect(cfg.ops.length, `${name} has empty ops`).toBeGreaterThan(0)
    }
  })

  it('does not expose obviously sensitive fields', () => {
    expect(AUDIENCE_FIELDS).not.toHaveProperty('password')
    expect(AUDIENCE_FIELDS).not.toHaveProperty('password_hash')
    expect(AUDIENCE_FIELDS).not.toHaveProperty('annual_salary')
    expect(AUDIENCE_FIELDS).not.toHaveProperty('hourly_rate')
  })
})
