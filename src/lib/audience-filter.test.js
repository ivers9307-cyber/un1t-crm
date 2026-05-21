import { describe, it, expect, beforeEach } from 'vitest'
import { applyAudienceFilter, AUDIENCE_FIELDS, InvalidAudienceFilterError, resolveTagFilters } from './audience-filter.js'

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
    applyAudienceFilter(q.query, { filters: [{ field: 'pipeline_stage_slug', op: 'eq', value: 'active_member' }] })
    expect(q.calls).toEqual([['eq', 'pipeline_stage_slug', 'active_member']])
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
    expect(() => applyAudienceFilter(q.query, { filters: [{ field: 'pipeline_stage_slug', op: 'contains', value: 'mem' }] }))
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

  // GLOFOX2.1.8 — glofox_membership_status is the synced Glofox-side
  // Client Status. Operator filters on this to build sequences
  // targeting Credit Members, ClassPass users, ex-members etc.
  it('applies glofox_membership_status eq for the credit_member audience', () => {
    applyAudienceFilter(q.query, {
      filters: [{ field: 'glofox_membership_status', op: 'eq', value: 'credit_member' }],
    })
    expect(q.calls).toEqual([['eq', 'glofox_membership_status', 'credit_member']])
  })

  it('applies glofox_membership_status eq for the classpass_payg audience', () => {
    applyAudienceFilter(q.query, {
      filters: [{ field: 'glofox_membership_status', op: 'eq', value: 'classpass_payg' }],
    })
    expect(q.calls).toEqual([['eq', 'glofox_membership_status', 'classpass_payg']])
  })

  it('applies glofox_membership_status is_null to find unsynced contacts', () => {
    applyAudienceFilter(q.query, {
      filters: [{ field: 'glofox_membership_status', op: 'is_null' }],
    })
    expect(q.calls).toEqual([['is', 'glofox_membership_status', null]])
  })

  // CHURN-PREP.2 — glofox_membership_plan is the synced plan name.
  it('applies glofox_membership_plan eq to target a specific plan', () => {
    applyAudienceFilter(q.query, {
      filters: [{ field: 'glofox_membership_plan', op: 'eq', value: '10 Class Pack' }],
    })
    expect(q.calls).toEqual([['eq', 'glofox_membership_plan', '10 Class Pack']])
  })

  it('applies glofox_membership_plan is_null for "no membership plan applied"', () => {
    applyAudienceFilter(q.query, {
      filters: [{ field: 'glofox_membership_plan', op: 'is_null' }],
    })
    expect(q.calls).toEqual([['is', 'glofox_membership_plan', null]])
  })

  it('applies glofox_membership_plan not_null for "has any membership plan"', () => {
    applyAudienceFilter(q.query, {
      filters: [{ field: 'glofox_membership_plan', op: 'not_null' }],
    })
    expect(q.calls).toEqual([['not', 'glofox_membership_plan', 'is', null]])
  })

  // GLOFOX-PROFILE (mig 196) — wider member-profile campaign filters.
  it('coerces a boolean string to a real boolean — glofox_roaming_enabled eq', () => {
    applyAudienceFilter(q.query, { filters: [{ field: 'glofox_roaming_enabled', op: 'eq', value: 'true' }] })
    expect(q.calls).toEqual([['eq', 'glofox_roaming_enabled', true]])
  })

  it('coerces "false" to a real boolean — glofox_account_active eq', () => {
    applyAudienceFilter(q.query, { filters: [{ field: 'glofox_account_active', op: 'eq', value: 'false' }] })
    expect(q.calls).toEqual([['eq', 'glofox_account_active', false]])
  })

  it('rejects a non-boolean value on a boolean field', () => {
    expect(() => applyAudienceFilter(q.query, { filters: [{ field: 'glofox_roaming_enabled', op: 'eq', value: 'maybe' }] }))
      .toThrow(/requires a boolean value/)
  })

  it('applies glofox_membership_type eq for class-pack targeting', () => {
    applyAudienceFilter(q.query, { filters: [{ field: 'glofox_membership_type', op: 'eq', value: 'num_classes' }] })
    expect(q.calls).toEqual([['eq', 'glofox_membership_type', 'num_classes']])
  })

  it('coerces glofox_membership_price_cents gt to a number', () => {
    applyAudienceFilter(q.query, { filters: [{ field: 'glofox_membership_price_cents', op: 'gt', value: '10000' }] })
    expect(q.calls).toEqual([['gt', 'glofox_membership_price_cents', 10000]])
  })

  // A date field with a comparison op carries an ISO date STRING — it
  // must pass through untouched, NOT be Number()-coerced. This is the
  // regression that previously rejected all date before/after filters.
  it('passes an ISO date string through for glofox_membership_expiry lt', () => {
    applyAudienceFilter(q.query, { filters: [{ field: 'glofox_membership_expiry', op: 'lt', value: '2026-07-01' }] })
    expect(q.calls).toEqual([['lt', 'glofox_membership_expiry', '2026-07-01']])
  })

  it('passes an ISO date string through for created_at gt (date before/after regression)', () => {
    applyAudienceFilter(q.query, { filters: [{ field: 'created_at', op: 'gt', value: '2026-01-01' }] })
    expect(q.calls).toEqual([['gt', 'created_at', '2026-01-01']])
  })

  it('still coerces the day-count for a date field days_since op', () => {
    applyAudienceFilter(q.query, { filters: [{ field: 'glofox_membership_expiry', op: 'days_since_gt', value: '14' }] })
    expect(q.calls).toHaveLength(1)
    expect(q.calls[0][0]).toBe('lt')
    expect(q.calls[0][1]).toBe('glofox_membership_expiry')
  })

  it('applies emergency_contact is_null to find members missing one', () => {
    applyAudienceFilter(q.query, { filters: [{ field: 'emergency_contact', op: 'is_null' }] })
    expect(q.calls).toEqual([['is', 'emergency_contact', null]])
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

  it('exposes the tag field with eq/neq operators (Phase 3)', () => {
    expect(AUDIENCE_FIELDS).toHaveProperty('tag')
    expect(AUDIENCE_FIELDS.tag.type).toBe('tag')
    expect(AUDIENCE_FIELDS.tag.ops).toEqual(['eq', 'neq'])
  })
})

// ─── tag virtual field — applyAudienceFilter skip behaviour ──────

describe('applyAudienceFilter — tag is a virtual field', () => {
  it('skips tag clauses (resolveTagFilters does the work)', () => {
    const q = makeMockQuery()
    applyAudienceFilter(q.query, {
      filters: [
        { field: 'tag', op: 'eq', value: 'race_completed' },
        { field: 'pipeline_stage_slug', op: 'eq', value: 'active_member' },
      ],
    })
    // Tag clause did NOT call query.eq — only the pipeline_stage_slug one did.
    expect(q.calls).toEqual([['eq', 'pipeline_stage_slug', 'active_member']])
  })

  it('still validates the operator allowlist for tag', () => {
    const q = makeMockQuery()
    expect(() => applyAudienceFilter(q.query, {
      filters: [{ field: 'tag', op: 'contains', value: 'race' }],
    })).toThrow(/not allowed on field "tag"/)
  })
})

// ─── resolveTagFilters — async tag → contact_id translation ──────

describe('resolveTagFilters — fast checks (no DB)', () => {
  // The full DB-backed behaviour (intersection, NOT IN, sentinel)
  // is exercised against real Supabase in production via the
  // /api/contacts/search + /api/segments routes. Mocking the
  // PromiseLike chain robustly inside vitest proved fragile; we
  // keep the behavioural tests at the integration layer and assert
  // only the synchronous edges here.

  it('is exported as an async function', () => {
    expect(typeof resolveTagFilters).toBe('function')
    // async functions return promises when invoked.
    const p = resolveTagFilters({ db: {}, query: {}, filter: null, locationId: null })
    expect(p).toBeInstanceOf(Promise)
  })

  it('returns { query } unchanged when filter is null', async () => {
    // Return shape is wrapped to defeat the thenable auto-unwrap —
    // see resolveTagFilters JSDoc.
    const dummyQuery = { id: 'unchanged' }
    const result = await resolveTagFilters({
      db: { from: () => { throw new Error('should not be called') } },
      query: dummyQuery,
      filter: null,
      locationId: null,
    })
    expect(result.query).toBe(dummyQuery)
  })

  it('returns { query } unchanged when no tag filters present', async () => {
    const dummyQuery = { id: 'unchanged' }
    const result = await resolveTagFilters({
      db: { from: () => { throw new Error('should not be called') } },
      query: dummyQuery,
      filter: { filters: [{ field: 'pipeline_stage_slug', op: 'eq', value: 'active_member' }] },
      locationId: null,
    })
    expect(result.query).toBe(dummyQuery)
  })

  it('rejects empty / whitespace tag values without hitting the DB', async () => {
    let dbCalled = false
    const db = { from: () => { dbCalled = true; return null } }
    await expect(resolveTagFilters({
      db,
      query: {},
      filter: { filters: [{ field: 'tag', op: 'eq', value: '   ' }] },
      locationId: 'loc-1',
    })).rejects.toThrow(/non-empty string/)
    expect(dbCalled).toBe(false)
  })
})
