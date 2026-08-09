import { describe, it, expect, beforeEach } from 'vitest'
import { applyAudienceFilter, AUDIENCE_FIELDS, InvalidAudienceFilterError, resolveTagFilters, resolveEventFilters, applyAudienceFilterAsync, mergeRegistrationContactIds, LIVE_REGISTRATION_STATUSES } from './audience-filter.js'

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

  // PILLAR2 — explicit recipients via { field:'id', op:'in', value:[…] }
  it('applies an id-in filter as .in(id, array) for explicit recipients', () => {
    applyAudienceFilter(q.query, { filters: [{ field: 'id', op: 'in', value: ['a', 'b', 'c'] }] })
    expect(q.calls).toEqual([['in', 'id', ['a', 'b', 'c']]])
  })

  it('forces an unsatisfiable predicate for an empty id-in array', () => {
    applyAudienceFilter(q.query, { filters: [{ field: 'id', op: 'in', value: [] }] })
    expect(q.calls).toEqual([['eq', 'id', '00000000-0000-0000-0000-000000000000']])
  })

  it('throws when an id-in value is not an array', () => {
    expect(() => applyAudienceFilter(q.query, { filters: [{ field: 'id', op: 'in', value: 'x' }] }))
      .toThrow(InvalidAudienceFilterError)
  })

  it('rejects a non-in operator on id (only "in" is whitelisted)', () => {
    expect(() => applyAudienceFilter(q.query, { filters: [{ field: 'id', op: 'eq', value: 'x' }] }))
      .toThrow(InvalidAudienceFilterError)
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

  // COMMSFIX.B.2 — Number('') / Number(null) / Number(true) are 0 / 0 / 1,
  // so a blank builder row silently became "= 0" (a large real cohort) and
  // "more than [blank] days ago" meant "ever". Blank/absent/boolean values
  // on numeric ops must error, not coerce.
  it('rejects an empty-string value on a numeric op instead of coercing to 0', () => {
    expect(() => applyAudienceFilter(q.query, { filters: [{ field: 'total_emails_sent', op: 'eq', value: '' }] }))
      .toThrow(InvalidAudienceFilterError)
    expect(() => applyAudienceFilter(q.query, { filters: [{ field: 'total_emails_sent', op: 'eq', value: '' }] }))
      .toThrow(/requires a numeric value/)
  })

  it('rejects a null value on a numeric op', () => {
    expect(() => applyAudienceFilter(q.query, { filters: [{ field: 'total_emails_sent', op: 'gte', value: null }] }))
      .toThrow(/requires a numeric value/)
  })

  it('rejects an undefined value on a numeric op', () => {
    expect(() => applyAudienceFilter(q.query, { filters: [{ field: 'total_emails_sent', op: 'lt' }] }))
      .toThrow(/requires a numeric value/)
  })

  it('rejects a boolean value on a numeric op (Number(true) is 1)', () => {
    expect(() => applyAudienceFilter(q.query, { filters: [{ field: 'total_emails_sent', op: 'eq', value: true }] }))
      .toThrow(/requires a numeric value/)
  })

  it('rejects a blank day-count on days_since ops instead of meaning "0 days ago"', () => {
    expect(() => applyAudienceFilter(q.query, { filters: [{ field: 'last_attended_at', op: 'days_since_gt', value: '' }] }))
      .toThrow(/requires a numeric value/)
    expect(() => applyAudienceFilter(q.query, { filters: [{ field: 'last_attended_at', op: 'days_since_lt', value: null }] }))
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

  // GYMPASS.1 — the Gympass audience segment: gympass_member_id not_null.
  it('builds the Gympass segment (gympass_member_id not_null)', () => {
    applyAudienceFilter(q.query, { filters: [{ field: 'gympass_member_id', op: 'not_null' }] })
    expect(q.calls).toEqual([['not', 'gympass_member_id', 'is', null]])
    expect(AUDIENCE_FIELDS.gympass_member_id).toBeDefined()
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

  it('applies glofox_membership_state eq for an overdue (locked) segment', () => {
    applyAudienceFilter(q.query, { filters: [{ field: 'glofox_membership_state', op: 'eq', value: 'locked' }] })
    expect(q.calls).toEqual([['eq', 'glofox_membership_state', 'locked']])
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

describe('applyAudienceFilter — OR logic (COMMS-AUDIT batch 6)', () => {
  let q
  beforeEach(() => { q = makeMockQuery() })

  it('AND remains the default — chains predicates, no .or()', () => {
    applyAudienceFilter(q.query, {
      logic: 'and',
      filters: [
        { field: 'pipeline_stage_slug', op: 'eq', value: 'active_member' },
        { field: 'email_status', op: 'eq', value: 'active' },
      ],
    })
    expect(q.calls).toEqual([
      ['eq', 'pipeline_stage_slug', 'active_member'],
      ['eq', 'email_status', 'active'],
    ])
  })

  it('OR combines scalar predicates into a single .or() string', () => {
    applyAudienceFilter(q.query, {
      logic: 'or',
      filters: [
        { field: 'pipeline_stage_slug', op: 'eq', value: 'active_member' },
        { field: 'email_status', op: 'eq', value: 'active' },
      ],
    })
    expect(q.calls).toEqual([
      ['or', 'pipeline_stage_slug.eq.active_member,email_status.eq.active'],
    ])
  })

  it('OR renders contains as ilike with % wildcards', () => {
    applyAudienceFilter(q.query, {
      logic: 'or',
      filters: [
        { field: 'name', op: 'contains', value: 'jo' },
        { field: 'email', op: 'contains', value: 'gmail' },
      ],
    })
    expect(q.calls).toEqual([
      ['or', 'name.ilike.%jo%,email.ilike.%gmail%'],
    ])
  })

  it('OR quotes a value containing reserved chars (comma)', () => {
    applyAudienceFilter(q.query, {
      logic: 'or',
      filters: [{ field: 'name', op: 'eq', value: 'Smith, Jr' }],
    })
    expect(q.calls).toEqual([['or', 'name.eq."Smith, Jr"']])
  })

  it('OR with a number range builds gt/lt conditions', () => {
    applyAudienceFilter(q.query, {
      logic: 'or',
      filters: [
        { field: 'total_bookings_30d', op: 'gte', value: 5 },
        { field: 'total_noshow_30d', op: 'gt', value: 2 },
      ],
    })
    expect(q.calls).toEqual([
      ['or', 'total_bookings_30d.gte.5,total_noshow_30d.gt.2'],
    ])
  })

  it('throws on OR combined with a tag virtual filter (rather than silently dropping it)', () => {
    expect(() => applyAudienceFilter(q.query, {
      logic: 'or',
      filters: [
        { field: 'pipeline_stage_slug', op: 'eq', value: 'active_member' },
        { field: 'tag', op: 'eq', value: 'vip' },
      ],
    })).toThrow(InvalidAudienceFilterError)
  })

  it('throws on OR combined with an event virtual filter', () => {
    expect(() => applyAudienceFilter(q.query, {
      logic: 'or',
      filters: [
        { field: 'email_status', op: 'eq', value: 'active' },
        { field: 'event_registration', op: 'eq', value: 'evt-1' },
      ],
    })).toThrow(InvalidAudienceFilterError)
  })
})

// COMMSFIX.B.1 — negative operators are NULL-inclusive. PostgREST neq /
// not.ilike / not.cs compile to SQL predicates that exclude NULL rows, so
// "membership type is not time" silently dropped every contact whose type
// was unsynced (229 live contacts; the 8-Aug sale-email incident class).
// Operator intent for "is not X" is "everyone except X", so each negative
// compiles to an OR group with `field.is.null`. Chained .or() calls AND
// together in PostgREST, so the AND branch emits one .or(neq,is.null) per
// negative filter; the OR branch nests each negative as an or(...) disjunct.
describe('applyAudienceFilter — NULL-inclusive negative operators (COMMSFIX.B.1)', () => {
  let q
  beforeEach(() => { q = makeMockQuery() })

  it('neq is NULL-inclusive: compiles to an or(neq, is.null) group', () => {
    applyAudienceFilter(q.query, {
      logic: 'and',
      filters: [{ field: 'glofox_membership_type', op: 'neq', value: 'time' }],
    })
    expect(q.calls).toEqual([
      ['or', 'glofox_membership_type.neq.time,glofox_membership_type.is.null'],
    ])
  })

  it('not_contains is NULL-inclusive', () => {
    applyAudienceFilter(q.query, {
      filters: [{ field: 'label', op: 'not_contains', value: 'x' }],
    })
    expect(q.calls).toEqual([
      ['or', 'label.not.ilike.%x%,label.is.null'],
    ])
  })

  it('numeric neq is NULL-inclusive and still coerces the value', () => {
    applyAudienceFilter(q.query, {
      filters: [{ field: 'glofox_membership_price_cents', op: 'neq', value: '10000' }],
    })
    expect(q.calls).toEqual([
      ['or', 'glofox_membership_price_cents.neq.10000,glofox_membership_price_cents.is.null'],
    ])
  })

  it('two negatives under AND emit one .or() group each (chained .or() calls AND)', () => {
    applyAudienceFilter(q.query, {
      logic: 'and',
      filters: [
        { field: 'glofox_membership_type', op: 'neq', value: 'time' },
        { field: 'glofox_membership_status', op: 'neq', value: 'member' },
      ],
    })
    expect(q.calls).toEqual([
      ['or', 'glofox_membership_type.neq.time,glofox_membership_type.is.null'],
      ['or', 'glofox_membership_status.neq.member,glofox_membership_status.is.null'],
    ])
  })

  it('tags neq / not_contains are NULL-inclusive (array branch)', () => {
    applyAudienceFilter(q.query, { filters: [{ field: 'tags', op: 'neq', value: 'PTC' }] })
    applyAudienceFilter(q.query, { filters: [{ field: 'tags', op: 'not_contains', value: 'PTC' }] })
    expect(q.calls).toEqual([
      ['or', 'tags.not.cs."{\\"PTC\\"}",tags.is.null'],
      ['or', 'tags.not.cs."{\\"PTC\\"}",tags.is.null'],
    ])
  })

  it('OR logic nests NULL-inclusive negatives as or() groups', () => {
    applyAudienceFilter(q.query, {
      logic: 'or',
      filters: [
        { field: 'glofox_membership_type', op: 'neq', value: 'time' },
        { field: 'pipeline_stage_slug', op: 'eq', value: 'member' },
      ],
    })
    expect(q.calls).toEqual([
      ['or', 'or(glofox_membership_type.neq.time,glofox_membership_type.is.null),pipeline_stage_slug.eq.member'],
    ])
  })

  it('OR logic nests a NULL-inclusive not_contains disjunct', () => {
    applyAudienceFilter(q.query, {
      logic: 'or',
      filters: [
        { field: 'label', op: 'not_contains', value: 'x' },
        { field: 'email_status', op: 'eq', value: 'active' },
      ],
    })
    expect(q.calls).toEqual([
      ['or', 'or(label.not.ilike.%x%,label.is.null),email_status.eq.active'],
    ])
  })
})

// TAGFIX — contacts.tags is text[]; the scalar eq/ilike path was a
// PostgREST 400 ("Couldn't compute recipient count") for every
// Free-text tag filter. Array fields route through cs instead.
describe('applyAudienceFilter — array field (contacts.tags)', () => {
  let q
  beforeEach(() => { q = makeMockQuery() })

  it('eq on tags uses .contains (cs), not scalar .eq', () => {
    applyAudienceFilter(q.query, { filters: [{ field: 'tags', op: 'eq', value: 'PTC' }] })
    expect(q.calls).toEqual([['contains', 'tags', ['PTC']]])
  })

  it('contains on tags means element membership — same cs as eq', () => {
    applyAudienceFilter(q.query, { filters: [{ field: 'tags', op: 'contains', value: 'PTC' }] })
    expect(q.calls).toEqual([['contains', 'tags', ['PTC']]])
  })

  // COMMSFIX.B.1 — negated tag membership is now NULL-inclusive: it
  // compiles to .or(not.cs, is.null) instead of the bare .not(cs) that
  // silently dropped contacts with a NULL tags column.
  it('neq on tags negates cs NULL-inclusively via .or()', () => {
    applyAudienceFilter(q.query, { filters: [{ field: 'tags', op: 'neq', value: 'PTC' }] })
    expect(q.calls).toEqual([['or', 'tags.not.cs."{\\"PTC\\"}",tags.is.null']])
  })

  it('not_contains mirrors neq', () => {
    applyAudienceFilter(q.query, { filters: [{ field: 'tags', op: 'not_contains', value: 'PTC' }] })
    expect(q.calls).toEqual([['or', 'tags.not.cs."{\\"PTC\\"}",tags.is.null']])
  })

  it('escapes quotes and backslashes in the negated array literal', () => {
    applyAudienceFilter(q.query, { filters: [{ field: 'tags', op: 'neq', value: 'a"b\\c' }] })
    // Array literal {"a\"b\\c"} then or-string quoting doubles the escapes —
    // same two-layer quoting the OR-branch test below has always locked in.
    const lit = '{"a\\"b\\\\c"}'
    const quoted = `"${lit.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    expect(q.calls).toEqual([['or', `tags.not.cs.${quoted},tags.is.null`]])
  })

  it('is_null / not_null still pass through', () => {
    applyAudienceFilter(q.query, { filters: [{ field: 'tags', op: 'is_null', value: null }] })
    applyAudienceFilter(q.query, { filters: [{ field: 'tags', op: 'not_null', value: null }] })
    expect(q.calls).toEqual([
      ['is', 'tags', null],
      ['not', 'tags', 'is', null],
    ])
  })

  it('OR renders tags eq as a quoted cs condition', () => {
    applyAudienceFilter(q.query, {
      logic: 'or',
      filters: [
        { field: 'tags', op: 'eq', value: 'PTC' },
        { field: 'email_status', op: 'eq', value: 'active' },
      ],
    })
    expect(q.calls).toEqual([
      ['or', 'tags.cs."{\\"PTC\\"}",email_status.eq.active'],
    ])
  })

  it('OR renders tags neq as a nested NULL-inclusive or() group', () => {
    applyAudienceFilter(q.query, {
      logic: 'or',
      filters: [{ field: 'tags', op: 'neq', value: 'PTC' }],
    })
    expect(q.calls).toEqual([['or', 'or(tags.not.cs."{\\"PTC\\"}",tags.is.null)']])
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

  it('exposes the event_registration field with eq/neq operators', () => {
    expect(AUDIENCE_FIELDS).toHaveProperty('event_registration')
    expect(AUDIENCE_FIELDS.event_registration.type).toBe('event')
    expect(AUDIENCE_FIELDS.event_registration.ops).toEqual(['eq', 'neq'])
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

// ─── event_registration virtual field — applyAudienceFilter skip ─

describe('applyAudienceFilter — event_registration is a virtual field', () => {
  it('skips event_registration clauses (resolveEventFilters does the work)', () => {
    const q = makeMockQuery()
    applyAudienceFilter(q.query, {
      filters: [
        { field: 'event_registration', op: 'eq', value: 'evt-1' },
        { field: 'pipeline_stage_slug', op: 'eq', value: 'active_member' },
      ],
    })
    expect(q.calls).toEqual([['eq', 'pipeline_stage_slug', 'active_member']])
  })

  it('still validates the operator allowlist for event_registration', () => {
    const q = makeMockQuery()
    expect(() => applyAudienceFilter(q.query, {
      filters: [{ field: 'event_registration', op: 'contains', value: 'evt' }],
    })).toThrow(/not allowed on field "event_registration"/)
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

// ─── event_registration virtual field ───────────────────────────

describe('LIVE_REGISTRATION_STATUSES', () => {
  it('is exactly pending_payment + confirmed (excludes cancelled + no_show)', () => {
    expect(LIVE_REGISTRATION_STATUSES).toEqual(['pending_payment', 'confirmed'])
  })
})

describe('mergeRegistrationContactIds', () => {
  it('unions registrants with teammates, dropping nulls and dupes', () => {
    const regs = [
      { contact_id: 'a', team_id: 't1' },
      { contact_id: null, team_id: 't2' },
      { contact_id: 'b', team_id: 't3' },
    ]
    const members = [{ contact_id: 'b' }, { contact_id: 'c' }, { contact_id: null }]
    const out = mergeRegistrationContactIds(regs, members)
    expect(new Set(out)).toEqual(new Set(['a', 'b', 'c']))
    expect(out).toHaveLength(3)
  })

  it('handles empty / null inputs', () => {
    expect(mergeRegistrationContactIds(null, null)).toEqual([])
    expect(mergeRegistrationContactIds([], [])).toEqual([])
  })
})

describe('resolveEventFilters — sync edges (no DB)', () => {
  it('is exported as an async function', () => {
    expect(typeof resolveEventFilters).toBe('function')
    expect(resolveEventFilters({ db: {}, query: {}, filter: null })).toBeInstanceOf(Promise)
  })

  it('returns { query } unchanged when filter is null', async () => {
    const dummyQuery = { id: 'unchanged' }
    const result = await resolveEventFilters({
      db: { from: () => { throw new Error('should not be called') } },
      query: dummyQuery, filter: null,
    })
    expect(result.query).toBe(dummyQuery)
  })

  it('returns { query } unchanged when no event filters present', async () => {
    const dummyQuery = { id: 'unchanged' }
    const result = await resolveEventFilters({
      db: { from: () => { throw new Error('should not be called') } },
      query: dummyQuery,
      filter: { filters: [{ field: 'pipeline_stage_slug', op: 'eq', value: 'active_member' }] },
    })
    expect(result.query).toBe(dummyQuery)
  })

  it('rejects empty / whitespace event ids without hitting the DB', async () => {
    let dbCalled = false
    const db = { from: () => { dbCalled = true; return null } }
    await expect(resolveEventFilters({
      db, query: {},
      filter: { filters: [{ field: 'event_registration', op: 'eq', value: '   ' }] },
    })).rejects.toThrow(/non-empty/)
    expect(dbCalled).toBe(false)
  })
})

describe('resolveEventFilters — DB-backed (explicit mock)', () => {
  // Explicit thenable chain per table (NOT a Proxy) — robust against the
  // PromiseLike auto-unwrap that makes Supabase-builder mocking fragile.
  function eventDb({ regs, members }) {
    // AUDIT P1-2 — both lookups now page through selectAll, so each chain ends
    // in .order().range(); the chain must answer those without breaking the
    // PromiseLike thenable. selectAll calls buildQuery(from,to) once and stops
    // when the page (regs/members, < pageSize) is short, so the data resolves
    // on the first page exactly as before.
    return {
      from(table) {
        if (table === 'race_registrations') {
          const chain = {
            select: () => chain, eq: () => chain, in: () => chain,
            order: () => chain, range: () => chain,
            then: (resolve) => Promise.resolve({ data: regs, error: null }).then(resolve),
          }
          return chain
        }
        if (table === 'team_members') {
          const chain = {
            select: () => chain, in: () => chain, not: () => chain,
            order: () => chain, range: () => chain,
            then: (resolve) => Promise.resolve({ data: members, error: null }).then(resolve),
          }
          return chain
        }
        throw new Error(`unexpected table ${table}`)
      },
    }
  }
  function captureQuery() {
    const calls = []
    const query = {
      in: (...a) => { calls.push(['in', ...a]); return query },
      eq: (...a) => { calls.push(['eq', ...a]); return query },
      not: (...a) => { calls.push(['not', ...a]); return query },
    }
    return { query, calls }
  }

  it('eq → query.in(id, registrants ∪ teammates)', async () => {
    const { query, calls } = captureQuery()
    const db = eventDb({ regs: [{ contact_id: 'a', team_id: 't1' }], members: [{ contact_id: 'b' }] })
    await resolveEventFilters({ db, query, filter: { filters: [{ field: 'event_registration', op: 'eq', value: 'evt-1' }] } })
    const inCall = calls.find(c => c[0] === 'in' && c[1] === 'id')
    expect(inCall).toBeTruthy()
    expect(new Set(inCall[2])).toEqual(new Set(['a', 'b']))
  })

  it('eq with no live registrations → unsatisfiable sentinel', async () => {
    const { query, calls } = captureQuery()
    const db = eventDb({ regs: [], members: [] })
    await resolveEventFilters({ db, query, filter: { filters: [{ field: 'event_registration', op: 'eq', value: 'evt-1' }] } })
    expect(calls).toContainEqual(['eq', 'id', '00000000-0000-0000-0000-000000000000'])
  })

  it('neq → query.not(id, in, (...))', async () => {
    const { query, calls } = captureQuery()
    const db = eventDb({ regs: [{ contact_id: 'a', team_id: 't1' }], members: [] })
    await resolveEventFilters({ db, query, filter: { filters: [{ field: 'event_registration', op: 'neq', value: 'evt-1' }] } })
    const notCall = calls.find(c => c[0] === 'not')
    expect(notCall).toBeTruthy()
    expect(notCall[1]).toBe('id')
    expect(notCall[2]).toBe('in')
    expect(notCall[3]).toContain('a')
  })

  it('applyAudienceFilterAsync resolves an event filter end to end', async () => {
    const { query, calls } = captureQuery()
    const db = eventDb({ regs: [{ contact_id: 'a', team_id: 't1' }], members: [] })
    await applyAudienceFilterAsync({
      db, query, locationId: 'loc-1',
      filter: { filters: [{ field: 'event_registration', op: 'eq', value: 'evt-1' }] },
    })
    expect(calls.some(c => c[0] === 'in' && c[1] === 'id')).toBe(true)
  })
})

// ─── AUDIT P1-2 — pagination: the virtual-field resolvers must read the
// FULL match set, not the first 1000 rows. Before the retrofit, a popular
// tag / large event silently truncated the audience at the PostgREST cap.
describe('resolveTagFilters / resolveEventFilters — paginate past the 1000-row cap', () => {
  // A PostgREST-style paged table: .range(from,to) returns rows[from..to],
  // capping each page at 1000 (the real db-max-rows) so a single page can
  // never exceed it. Records every page's [from,to] so the test can assert
  // the resolver kept paging until a short page.
  function pagedTable(rows, pages) {
    let from = 0, to = 0
    const chain = {
      select: () => chain, eq: () => chain, is: () => chain, in: () => chain, not: () => chain,
      order: () => chain,
      range: (f, t) => { from = f; to = t; pages.push([f, t]); return chain },
      then: (resolve) => {
        const slice = rows.slice(from, Math.min(to + 1, from + 1000))
        return Promise.resolve({ data: slice, error: null }).then(resolve)
      },
    }
    return chain
  }
  function captureQuery() {
    const calls = []
    const query = {
      in: (...a) => { calls.push(['in', ...a]); return query },
      eq: (...a) => { calls.push(['eq', ...a]); return query },
      not: (...a) => { calls.push(['not', ...a]); return query },
    }
    return { query, calls }
  }

  it('contactIdsForTag pages through a >1000-row tag cohort (eq → query.in gets ALL ids)', async () => {
    const ids = Array.from({ length: 2500 }, (_, i) => `c-${i}`)
    const rows = ids.map((id) => ({ contact_id: id }))
    const pages = []
    const db = { from: () => pagedTable(rows, pages) }
    const { query, calls } = captureQuery()

    await resolveTagFilters({
      db, query, locationId: 'loc-1',
      filter: { filters: [{ field: 'tag', op: 'eq', value: 'vip' }] },
    })

    // Three pages (1000 + 1000 + 500) — proves it didn't stop at the cap.
    expect(pages.length).toBe(3)
    const inCall = calls.find(c => c[0] === 'in' && c[1] === 'id')
    expect(inCall).toBeTruthy()
    expect(inCall[2]).toHaveLength(2500)
    expect(new Set(inCall[2])).toEqual(new Set(ids))
  })

  it('contactIdsForEvent pages through a >1000-row registration list', async () => {
    const regs = Array.from({ length: 1800 }, (_, i) => ({ contact_id: `r-${i}`, team_id: null }))
    const pages = []
    const db = {
      from(table) {
        if (table === 'race_registrations') return pagedTable(regs, pages)
        if (table === 'team_members') return pagedTable([], [])
        throw new Error(`unexpected table ${table}`)
      },
    }
    const { query, calls } = captureQuery()

    await resolveEventFilters({
      db, query,
      filter: { filters: [{ field: 'event_registration', op: 'eq', value: 'evt-1' }] },
    })

    expect(pages.length).toBe(2)   // 1000 + 800
    const inCall = calls.find(c => c[0] === 'in' && c[1] === 'id')
    expect(inCall).toBeTruthy()
    expect(inCall[2]).toHaveLength(1800)
  })
})
