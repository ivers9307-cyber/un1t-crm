// HATCHVISIT.1 — the un1t.online visited-within virtual field.
import { describe, it, expect } from 'vitest'
import { resolveVirtualIdSets, applyAudienceFilter, UN1T_VISIT_DAYS, InvalidAudienceFilterError } from './audience-filter'

// A builder that records filters and returns canned un1t_clients rows once.
function fakeDb(rows) {
  const calls = []
  return {
    calls,
    from(table) {
      const c = { table, filters: [] }
      calls.push(c)
      const b = {
        select: () => b, order: () => b,
        eq: (...a) => { c.filters.push(['eq', ...a]); return b },
        gte: (...a) => { c.filters.push(['gte', ...a]); return b },
        not: (...a) => { c.filters.push(['not', ...a]); return b },
        range: (from) => Promise.resolve({ data: from === 0 ? rows : [], error: null }),
      }
      return b
    },
  }
}

const LOC = 'a0000000-0000-4000-8000-000000000001'
const f = (op, value) => ({ logic: 'and', filters: [{ field: 'un1t_visited_within', op, value }] })

describe('un1t_visited_within (HATCHVISIT.1)', () => {
  it('eq N keeps only people who visited this studio within N days', async () => {
    const db = fakeDb([{ contact_id: 'c1' }, { contact_id: 'c2' }, { contact_id: 'c1' }])
    const sets = await resolveVirtualIdSets({ db, filter: f('eq', '90'), locationId: LOC })
    expect([...sets.include].sort()).toEqual(['c1', 'c2'])
    expect(db.calls[0].table).toBe('un1t_clients')
    expect(db.calls[0].filters).toContainEqual(['eq', 'location_id', LOC])
    expect(db.calls[0].filters.find((x) => x[0] === 'gte')[1]).toBe('last_attended_at')
  })

  it('neq N removes them and leaves everyone else (never visited included)', async () => {
    const db = fakeDb([{ contact_id: 'c1' }])
    const sets = await resolveVirtualIdSets({ db, filter: f('neq', '30'), locationId: LOC })
    expect(sets.include).toBe(null)
    expect([...sets.exclude]).toEqual(['c1'])
  })

  it('only accepts the listed windows', async () => {
    expect(UN1T_VISIT_DAYS).toEqual(['30', '60', '90', '180', '365'])
    await expect(resolveVirtualIdSets({ db: fakeDb([]), filter: f('eq', '7'), locationId: LOC })).rejects.toBeInstanceOf(InvalidAudienceFilterError)
  })

  it('is not applied as a scalar column, and refuses OR logic like the other virtual fields', () => {
    const q = { eq: () => { throw new Error('should not be a column') }, neq: () => { throw new Error('should not be a column') } }
    expect(() => applyAudienceFilter(q, f('eq', '90'))).not.toThrow()
    expect(() => applyAudienceFilter(q, { logic: 'or', filters: [{ field: 'un1t_visited_within', op: 'eq', value: '90' }, { field: 'email', op: 'eq', value: 'x' }] }))
      .toThrow(InvalidAudienceFilterError)
  })
})
