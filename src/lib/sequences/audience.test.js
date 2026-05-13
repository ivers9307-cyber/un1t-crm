// audience-match tests. The contract every sequence trigger
// depends on, so the test surface needs to cover:
//   - the empty-filter shortcut (the common case — must never
//     accidentally trip the DB-call path)
//   - matched/not-matched outcomes from the count() query
//   - graceful failure on a bad filter (returns false, not throws)
//   - any other thrown error bubbles up (so the cron can pause + log)
//   - the locationId is read from the contact row before the
//     audience filter is applied (regression guard for mig 085)

import { describe, it, expect, vi } from 'vitest'

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

const { contactMatchesSequenceAudience } = await import('./audience.js')

// Mock Supabase chain: from(...).select(...).eq(...) → maybeSingle / count.
function mockDb({ contactRow = { location_id: 'loc-1' }, count = 1 } = {}) {
  // count-query ends with the head:true select then audience-filter
  // returns the same chain shape with a `count` getter.
  const countQuery = {
    eq: vi.fn().mockReturnThis(),
    // Final await: vitest's await-thenable behaviour — return { count }.
    then: (onFulfilled) => Promise.resolve({ count }).then(onFulfilled),
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
