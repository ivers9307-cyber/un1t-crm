// audience-match tests. The contract every sequence trigger
// depends on, so the test surface needs to cover:
//   - the empty-filter shortcut (the common case — must never
//     accidentally trip the DB-call path)
//   - matched/not-matched outcomes from the count() query
//   - graceful failure on a bad filter (returns false, not throws)
//   - any other thrown error bubbles up (so the cron can pause + log)
//   - the locationId is read from the contact row before the
//     audience filter is applied (regression guard for mig 085)

import { describe, it, expect, vi, beforeEach } from 'vitest'

// SEQEXIT.1 — logWarn is part of the contract now: every 'unknown'
// outcome must leave an operator signal behind, so the tests assert
// on it rather than letting it print.
vi.mock('@/lib/log', () => ({
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}))

// Mock audience-filter module. We control whether applyAudienceFilterAsync
// resolves, throws InvalidAudienceFilterError, or throws something else.
const applyAudienceFilterAsync = vi.fn()
class InvalidAudienceFilterError extends Error {
  constructor(message) { super(message); this.name = 'InvalidAudienceFilterError' }
}
vi.mock('@/lib/audience-filter', () => ({
  applyAudienceFilterAsync: (...args) => applyAudienceFilterAsync(...args),
  InvalidAudienceFilterError,
}))

const { contactMatchesSequenceAudience, evaluateSequenceAudience } = await import('./audience.js')
const { logWarn } = await import('@/lib/log')

beforeEach(() => {
  logWarn.mockClear()
})

// Mock Supabase chain: from(...).select(...).eq(...) → maybeSingle / count.
function mockDb({ contactRow = { location_id: 'loc-1' }, count = 1, countError = null } = {}) {
  // count-query ends with the head:true select then audience-filter
  // returns the same chain shape with a `count` getter.
  const countQuery = {
    eq: vi.fn().mockReturnThis(),
    // Final await: vitest's await-thenable behaviour — return
    // { count, error }, the real PostgREST result shape. A failed
    // query returns an `error` object rather than throwing.
    then: (onFulfilled) =>
      Promise.resolve(countError ? { count: null, error: countError } : { count, error: null })
        .then(onFulfilled),
  }

  const contactQuery = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: contactRow }),
  }

  return {
    from: vi.fn((table) => {
      if (table === 'contacts') {
        // Return a chain object whose .select branches:
        //   select('location_id') → contactQuery (.maybeSingle)
        //   select('id', { count }) → countQuery (.eq returns self,
        //     awaiting it returns { count })
        return {
          select: vi.fn((cols, opts) => {
            if (opts && opts.count === 'exact') {
              return countQuery
            }
            return contactQuery
          }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    }),
  }
}

describe('contactMatchesSequenceAudience — empty filter shortcut', () => {
  it('returns true without touching the DB when filter is null', async () => {
    const db = mockDb()
    expect(await contactMatchesSequenceAudience(db, 'c1', null)).toBe(true)
    expect(db.from).not.toHaveBeenCalled()
  })

  it('returns true when filter is undefined', async () => {
    const db = mockDb()
    expect(await contactMatchesSequenceAudience(db, 'c1', undefined)).toBe(true)
    expect(db.from).not.toHaveBeenCalled()
  })

  it('returns true when filter.filters is missing', async () => {
    const db = mockDb()
    expect(await contactMatchesSequenceAudience(db, 'c1', { logic: 'and' })).toBe(true)
    expect(db.from).not.toHaveBeenCalled()
  })

  it('returns true when filter.filters is empty', async () => {
    const db = mockDb()
    expect(await contactMatchesSequenceAudience(db, 'c1', { filters: [] })).toBe(true)
    expect(db.from).not.toHaveBeenCalled()
  })
})

describe('contactMatchesSequenceAudience — DB count outcome', () => {
  const filter = { logic: 'and', filters: [{ field: 'pipeline_stage_slug', op: 'eq', value: 'active_member' }] }

  it('returns true when count > 0 (contact matches)', async () => {
    const db = mockDb({ count: 1 })
    // GLOFOX/audience-thenable fix — mock now returns the wrapped { query }
    // shape that the production helper produces (defeats the await/thenable
    // auto-unwrap of bare Supabase builders).
    applyAudienceFilterAsync.mockImplementation(({ query }) => ({ query }))
    expect(await contactMatchesSequenceAudience(db, 'c1', filter)).toBe(true)
  })

  it('returns false when count is 0 (contact does not match)', async () => {
    const db = mockDb({ count: 0 })
    // GLOFOX/audience-thenable fix — mock now returns the wrapped { query }
    // shape that the production helper produces (defeats the await/thenable
    // auto-unwrap of bare Supabase builders).
    applyAudienceFilterAsync.mockImplementation(({ query }) => ({ query }))
    expect(await contactMatchesSequenceAudience(db, 'c1', filter)).toBe(false)
  })

  it('returns false when count is null (defensive)', async () => {
    const db = mockDb({ count: null })
    // GLOFOX/audience-thenable fix — mock now returns the wrapped { query }
    // shape that the production helper produces (defeats the await/thenable
    // auto-unwrap of bare Supabase builders).
    applyAudienceFilterAsync.mockImplementation(({ query }) => ({ query }))
    expect(await contactMatchesSequenceAudience(db, 'c1', filter)).toBe(false)
  })
})

describe('contactMatchesSequenceAudience — locationId resolution', () => {
  const filter = { logic: 'and', filters: [{ field: 'tag', op: 'eq', value: 'vip' }] }

  it('passes the contact\'s location_id into applyAudienceFilterAsync', async () => {
    const db = mockDb({ contactRow: { location_id: 'loc-42' } })
    // GLOFOX/audience-thenable fix — mock now returns the wrapped { query }
    // shape that the production helper produces (defeats the await/thenable
    // auto-unwrap of bare Supabase builders).
    applyAudienceFilterAsync.mockImplementation(({ query }) => ({ query }))
    await contactMatchesSequenceAudience(db, 'c1', filter)
    expect(applyAudienceFilterAsync).toHaveBeenCalledWith(
      expect.objectContaining({ locationId: 'loc-42' })
    )
  })

  it('passes locationId: null when the contact lookup returns no row', async () => {
    const db = mockDb({ contactRow: null })
    // GLOFOX/audience-thenable fix — mock now returns the wrapped { query }
    // shape that the production helper produces (defeats the await/thenable
    // auto-unwrap of bare Supabase builders).
    applyAudienceFilterAsync.mockImplementation(({ query }) => ({ query }))
    await contactMatchesSequenceAudience(db, 'c1', filter)
    expect(applyAudienceFilterAsync).toHaveBeenCalledWith(
      expect.objectContaining({ locationId: null })
    )
  })
})

describe('contactMatchesSequenceAudience — error handling', () => {
  const filter = { filters: [{ field: 'x', op: '?', value: 'y' }] }

  it('returns false on InvalidAudienceFilterError (does NOT throw)', async () => {
    // The cron path can\'t crash on a single bad filter — the safe
    // direction is "no match", so the broken sequence quietly stops
    // enrolling rather than nuking the run.
    const db = mockDb()
    applyAudienceFilterAsync.mockImplementation(() => {
      throw new InvalidAudienceFilterError('unknown op')
    })
    expect(await contactMatchesSequenceAudience(db, 'c1', filter)).toBe(false)
  })

  it('logs a warning when the count query fails (does NOT read it as no-match)', async () => {
    // Pre-SEQEXIT.1 this path read `(count ?? 0) > 0` without ever
    // checking `error`, so a failed query looked exactly like "the
    // contact does not match".
    const db = mockDb({ countError: { message: 'timeout' } })
    applyAudienceFilterAsync.mockImplementation(({ query }) => ({ query }))
    expect(await contactMatchesSequenceAudience(db, 'c1', { filters: [{ field: 'x', op: 'eq', value: 'y' }] })).toBe(false)
    expect(logWarn).toHaveBeenCalled()
  })

  it('rethrows non-InvalidAudienceFilterError', async () => {
    // Anything else (e.g. a transient Supabase error) should bubble
    // up so the cron logs it as the actual underlying failure
    // rather than masking it as no-match.
    const db = mockDb()
    applyAudienceFilterAsync.mockImplementation(() => {
      throw new Error('connection reset')
    })
    await expect(contactMatchesSequenceAudience(db, 'c1', filter))
      .rejects.toThrow('connection reset')
  })
})

// ── SEQEXIT.1 — the three-state evaluator ────────────────────────
//
// The audience became a CONTINUING condition: the scheduler re-checks
// it before every step and EXITS the enrolment on a definite no-match.
// Exiting is irreversible and there is no manual re-entry, so the
// evaluator must distinguish "definitely does not match" from
// "we could not tell". Two states cannot carry that difference —
// `false` would terminate live enrolments on one malformed filter or
// one transient DB error.

describe('evaluateSequenceAudience — three-state outcomes', () => {
  const filter = { logic: 'and', filters: [{ field: 'pipeline_stage_slug', op: 'eq', value: 'active_member' }] }

  it("returns 'match' without touching the DB when there is no filter", async () => {
    const db = mockDb()
    expect(await evaluateSequenceAudience(db, 'c1', null)).toBe('match')
    expect(await evaluateSequenceAudience(db, 'c1', undefined)).toBe('match')
    expect(await evaluateSequenceAudience(db, 'c1', { logic: 'and' })).toBe('match')
    expect(await evaluateSequenceAudience(db, 'c1', { filters: [] })).toBe('match')
    expect(db.from).not.toHaveBeenCalled()
  })

  it("returns 'match' when the count query returns > 0", async () => {
    const db = mockDb({ count: 1 })
    applyAudienceFilterAsync.mockImplementation(({ query }) => ({ query }))
    expect(await evaluateSequenceAudience(db, 'c1', filter)).toBe('match')
    expect(logWarn).not.toHaveBeenCalled()
  })

  it("returns 'no_match' when the count query returns 0", async () => {
    const db = mockDb({ count: 0 })
    applyAudienceFilterAsync.mockImplementation(({ query }) => ({ query }))
    expect(await evaluateSequenceAudience(db, 'c1', filter)).toBe('no_match')
    expect(logWarn).not.toHaveBeenCalled()
  })

  it("returns 'unknown' + logs on InvalidAudienceFilterError (never 'no_match')", async () => {
    const db = mockDb()
    applyAudienceFilterAsync.mockImplementation(() => {
      throw new InvalidAudienceFilterError('unknown op')
    })
    expect(await evaluateSequenceAudience(db, 'c1', filter)).toBe('unknown')
    expect(logWarn).toHaveBeenCalled()
  })

  it("returns 'unknown' + logs when the count query returns an error — NOT 'no_match'", async () => {
    // THE fail-open guarantee at the evaluator level: a transient
    // Supabase failure resolves to { count: null, error } rather than
    // throwing, and the old `(count ?? 0) > 0` read that as no-match.
    const db = mockDb({ countError: { message: 'statement timeout' } })
    applyAudienceFilterAsync.mockImplementation(({ query }) => ({ query }))
    const state = await evaluateSequenceAudience(db, 'c1', filter)
    expect(state).toBe('unknown')
    expect(state).not.toBe('no_match')
    expect(logWarn).toHaveBeenCalled()
  })

  it("returns 'unknown' + logs on any other throw, and does not let it escape", async () => {
    // An escaping throw would kill the whole cron tick; a `false`
    // would exit the enrolment. Neither is acceptable — 'unknown' is.
    const db = mockDb()
    applyAudienceFilterAsync.mockImplementation(() => {
      throw new Error('connection reset')
    })
    expect(await evaluateSequenceAudience(db, 'c1', filter)).toBe('unknown')
    expect(logWarn).toHaveBeenCalled()
  })

  it("returns 'unknown' when the contact lookup itself throws", async () => {
    const db = { from: vi.fn(() => { throw new Error('socket hang up') }) }
    expect(await evaluateSequenceAudience(db, 'c1', filter)).toBe('unknown')
    expect(logWarn).toHaveBeenCalled()
  })
})

describe('contactMatchesSequenceAudience — enrolment contract is unchanged', () => {
  const filter = { filters: [{ field: 'x', op: '?', value: 'y' }] }

  it('still returns false for an invalid filter (nobody enrolled by accident)', async () => {
    // The wrapper collapses 'unknown' to false. For ENROLMENT that is
    // still the right direction — this is the test that pins it.
    const db = mockDb()
    applyAudienceFilterAsync.mockImplementation(() => {
      throw new InvalidAudienceFilterError('unknown op')
    })
    expect(await contactMatchesSequenceAudience(db, 'c1', filter)).toBe(false)
  })

  it('still returns true/false in step with the evaluator for match/no_match', async () => {
    applyAudienceFilterAsync.mockImplementation(({ query }) => ({ query }))
    expect(await contactMatchesSequenceAudience(mockDb({ count: 1 }), 'c1', filter)).toBe(true)
    expect(await contactMatchesSequenceAudience(mockDb({ count: 0 }), 'c1', filter)).toBe(false)
  })
})
