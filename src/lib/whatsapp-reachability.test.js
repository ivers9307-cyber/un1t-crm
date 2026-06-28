import { describe, it, expect, vi } from 'vitest'
import { computeWhatsAppReachabilitySummary } from './whatsapp.js'

// applyAudienceFilterAsync is async and resolves virtual fields; stub it to a
// pass-through so we exercise only the count assembly.
vi.mock('./audience-filter', () => ({
  applyAudienceFilter: (q) => q,
  applyAudienceFilterAsync: async ({ query }) => ({ query }),
}))

// A fluent builder whose terminal await resolves to a configured count. Each
// db.from() returns a fresh builder; we hand back counts in call order.
function dbReturningCounts(counts) {
  let i = 0
  function makeBuilder() {
    const value = { count: counts[i++] ?? 0, error: null }
    const builder = new Proxy({}, {
      get(_, prop) {
        if (prop === 'then') return (resolve) => resolve(value)
        return () => builder
      },
    })
    return builder
  }
  return { from: () => makeBuilder() }
}

describe('computeWhatsAppReachabilitySummary', () => {
  it('returns matched, reachable, and the three exclusion reason counts', async () => {
    // Call order in the helper: matched, reachable, no_number, no_consent, opted_out
    const db = dbReturningCounts([10, 6, 3, 2, 1])
    const out = await computeWhatsAppReachabilitySummary(db, { logic: 'and', filters: [] }, 'loc')
    expect(out).toEqual({
      matched: 10,
      reachable: 6,
      excluded: { no_number: 3, no_consent: 2, opted_out: 1 },
    })
  })

  it('coerces null counts to 0', async () => {
    const db = dbReturningCounts([null, null, null, null, null])
    const out = await computeWhatsAppReachabilitySummary(db, { logic: 'and', filters: [] }, 'loc')
    expect(out).toEqual({ matched: 0, reachable: 0, excluded: { no_number: 0, no_consent: 0, opted_out: 0 } })
  })
})
