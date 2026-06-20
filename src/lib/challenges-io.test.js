import { describe, it, expect } from 'vitest'
import { computeStandings, computeCollective } from './challenges-io.js'

function fakeDb(rows) {
  const q = {
    select: () => q, eq: () => q, not: () => q, gte: () => q, lt: () => q,
    order: () => q, range: async () => ({ data: rows, error: null }),
  }
  return { from: () => q }
}
const rows = [
  { contact_id: 'a', effort_points: 300, zones_seconds: {}, contacts: { name: 'Sarah Kelly' } },
  { contact_id: 'a', effort_points: 200, zones_seconds: {}, contacts: { name: 'Sarah Kelly' } },
  { contact_id: 'b', effort_points: 450, zones_seconds: {}, contacts: { name: 'Mike Doyle' } },
]

describe('computeStandings', () => {
  it('aggregates points per contact, ranked, projected', async () => {
    const out = await computeStandings(fakeDb(rows), { locationId: 'L', metric: 'points', fromIso: 'x', toIso: 'y' })
    expect(out.map((r) => [r.name, r.value, r.rank])).toEqual([['Sarah K.', 500, 1], ['Mike D.', 450, 2]])
  })
})
describe('computeCollective', () => {
  it('sums all + pct', async () => {
    const out = await computeCollective(fakeDb(rows), { locationId: 'L', metric: 'points', fromIso: 'x', toIso: 'y', target: 1000 })
    expect(out).toEqual({ total: 950, target: 1000, pct: 0.95 })
  })
})
