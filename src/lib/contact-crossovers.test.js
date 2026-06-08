import { describe, it, expect } from 'vitest'
import { crossoverContactIds, fetchCrossoverContext, canViewContact } from './contact-crossovers'

// Minimal chainable stub of the supabase builder. `result` is what the
// awaited query resolves to ({ data } or { data, count }).
function stubFrom(handlers) {
  return {
    from(table) {
      const calls = { table, filters: {} }
      const builder = {
        select() { return builder },
        eq(col, val) { calls.filters[col] = val; return builder },
        in(col, vals) { calls.filters[col] = vals; return builder },
        is(col, val) { calls.filters[`${col}__is`] = val; return builder },
        not() { return builder },
        order() { return builder },
        range(from, to) { calls.range = [from, to]; return builder },
        limit(n) { calls.limit = n; return builder },
        then(resolve) { return Promise.resolve(handlers[table](calls)).then(resolve) },
      }
      return builder
    },
  }
}

describe('crossoverContactIds', () => {
  it('returns the distinct contact_ids with a deal at the location (one page)', async () => {
    const db = stubFrom({
      deals: () => ({ data: [{ contact_id: 'a' }, { contact_id: 'b' }, { contact_id: 'a' }] }),
    })
    expect((await crossoverContactIds(db, 'loc1')).sort()).toEqual(['a', 'b'])
  })
  it('returns [] for missing args / empty result', async () => {
    expect(await crossoverContactIds(null, 'loc1')).toEqual([])
    const db = stubFrom({ deals: () => ({ data: [] }) })
    expect(await crossoverContactIds(db, 'loc1')).toEqual([])
  })
})

describe('fetchCrossoverContext', () => {
  const active = 'hatch'
  const contacts = [
    { id: 'c1', location_id: 'hatch' },        // owned — not a crossover
    { id: 'c2', location_id: 'stillorgan' },   // crossover
  ]
  it('maps home-studio + tags for crossover contacts only', async () => {
    const db = stubFrom({
      locations: () => ({ data: [{ id: 'stillorgan', name: 'UN1T Stillorgan' }] }),
      contact_tags: () => ({ data: [{ contact_id: 'c2', tag: 'member' }, { contact_id: 'c2', tag: 'vip' }] }),
    })
    const ctx = await fetchCrossoverContext(db, contacts, active)
    expect(ctx).toEqual({ c2: { homeStudio: 'UN1T Stillorgan', tags: ['member', 'vip'] } })
    expect(ctx.c1).toBeUndefined()
  })
  it('returns {} when there are no crossovers', async () => {
    const db = stubFrom({ locations: () => ({ data: [] }), contact_tags: () => ({ data: [] }) })
    expect(await fetchCrossoverContext(db, [{ id: 'c1', location_id: 'hatch' }], active)).toEqual({})
  })
})

describe('canViewContact', () => {
  // deals stub: resolves whatever rows the crossover deal-probe should see.
  const dealStub = (rows) => stubFrom({ deals: () => ({ data: rows }) })

  it('master sees any contact without a db probe', async () => {
    // db is null on purpose — a master must never reach the deal query.
    expect(await canViewContact(null, { isMaster: true }, { id: 'c1', location_id: 'L2' })).toBe(true)
  })
  it('owner of the contact location sees it (no deal probe needed)', async () => {
    const user = { isMaster: false, locations: [{ id: 'L1' }, { id: 'L2' }] }
    expect(await canViewContact(dealStub([]), user, { id: 'c1', location_id: 'L2' })).toBe(true)
  })
  it('crossover: a deal at one of the caller locations grants access', async () => {
    const user = { isMaster: false, locations: [{ id: 'L1' }] }
    expect(await canViewContact(dealStub([{ id: 'd1' }]), user, { id: 'c1', location_id: 'L2' })).toBe(true)
  })
  it('not owned and no crossover deal → denied', async () => {
    const user = { isMaster: false, locations: [{ id: 'L1' }] }
    expect(await canViewContact(dealStub([]), user, { id: 'c1', location_id: 'L2' })).toBe(false)
  })
  it('null user or null contact → denied', async () => {
    expect(await canViewContact(dealStub([]), null, { id: 'c1', location_id: 'L1' })).toBe(false)
    expect(await canViewContact(dealStub([]), { isMaster: false, locations: [{ id: 'L1' }] }, null)).toBe(false)
  })
  it('caller with no location assignments and not owner → denied without probing deals', async () => {
    // Even though the deal stub WOULD return a row, the empty-locations
    // short-circuit must deny before any query runs.
    const user = { isMaster: false, locations: [] }
    expect(await canViewContact(dealStub([{ id: 'd1' }]), user, { id: 'c1', location_id: 'L2' })).toBe(false)
  })
})
