import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/audience-filter', () => ({
  applyAudienceFilterAsync: vi.fn(async ({ query }) => ({ query })),
  scopedAudienceSource: vi.fn(),
}))
vi.mock('@/lib/audience-eligibility', () => ({
  buildEligibleAudienceQuery: vi.fn(async () => ({
    query: { then: (resolve) => resolve({ count: 2300, error: null }) },
  })),
}))

import { emailAudienceCounts } from './email-audience-counts'
import { buildEligibleAudienceQuery } from '@/lib/audience-eligibility'

// One count per awaited view query, in call order; a count of an Error
// object resolves as a query error.
function fakeCountDb(...counts) {
  const remaining = [...counts]
  const makeBuilder = () => new Proxy({}, {
    get(_, prop) {
      if (prop === 'then') {
        const next = remaining.shift()
        return (resolve) => resolve(
          next instanceof Error ? { count: null, error: { message: next.message } } : { count: next, error: null },
        )
      }
      return function chain() { return this }
    },
  })
  return { from: () => makeBuilder() }
}

describe('emailAudienceCounts', () => {
  it('returns matched, eligible and the three excluded counts', async () => {
    const filter = { logic: 'and', filters: [] }
    const out = await emailAudienceCounts(fakeCountDb(4900, 1200, 24, 300), { filter, locationId: 'loc' })
    expect(out).toEqual({
      matched: 4900,
      eligible: 2300,
      excluded: { not_opted_in: 1200, bounced_or_complained: 24, suppressed: 300 },
    })
    expect(buildEligibleAudienceQuery).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'email', filter, locationId: 'loc',
      columns: 'id', selectOpts: { count: 'exact', head: true },
    }))
  })

  it('throws when a count query errors', async () => {
    const filter = { logic: 'and', filters: [] }
    await expect(
      emailAudienceCounts(fakeCountDb(4900, new Error('view boom')), { filter, locationId: 'loc' }),
    ).rejects.toThrow(/view boom/)
    buildEligibleAudienceQuery.mockResolvedValueOnce({
      query: { then: (resolve) => resolve({ count: null, error: { message: 'eligible boom' } }) },
    })
    await expect(
      emailAudienceCounts(fakeCountDb(1, 1, 1, 1), { filter, locationId: 'loc' }),
    ).rejects.toThrow(/eligible boom/)
  })
})
