import { describe, it, expect } from 'vitest'
import { crossoverContactIds, fetchCrossoverContext, canViewContact, fetchListMembershipFlags, CROSSOVER_ID_CAP } from './contact-crossovers'

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
    // Stub of db.rpc(fn, args) → resolves to { data, error } from the
    // named handler (crossoverContactIds now calls an RPC, not .from()).
    rpc(fn, args) {
      return Promise.resolve(handlers[fn] ? handlers[fn](args) : { data: null, error: null })
    },
  }
}

describe('crossoverContactIds', () => {
  it('returns the contact_ids from the crossover_contact_ids RPC', async () => {
    const db = stubFrom({
      crossover_contact_ids: () => ({ data: [{ contact_id: 'a' }, { contact_id: 'b' }] }),
    })
    expect((await crossoverContactIds(db, 'loc1')).sort()).toEqual(['a', 'b'])
  })
  it('returns [] for missing args / empty result / rpc error', async () => {
    expect(await crossoverContactIds(null, 'loc1')).toEqual([])
    expect(await crossoverContactIds(stubFrom({ crossover_contact_ids: () => ({ data: [] }) }), 'loc1')).toEqual([])
    expect(await crossoverContactIds(stubFrom({ crossover_contact_ids: () => ({ data: null, error: { message: 'boom' } }) }), 'loc1')).toEqual([])
  })
  it('caps the list at CROSSOVER_ID_CAP so the id.in() URL can never blow up', async () => {
    const many = Array.from({ length: CROSSOVER_ID_CAP + 50 }, (_, i) => ({ contact_id: `c${i}` }))
    const db = stubFrom({ crossover_contact_ids: () => ({ data: many }) })
    expect((await crossoverContactIds(db, 'loc1')).length).toBe(CROSSOVER_ID_CAP)
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

describe('fetchListMembershipFlags', () => {
  const active = 'stillorgan'
  // Richard's actual shape: a Stillorgan-owned contact who registered
  // interest in Hatch Street. `crossover_contact_ids` cannot see this
  // person at all (they hold no deal at Hatch) — a preferences row is the
  // only trace, which is exactly why this helper exists.
  const contacts = [
    { id: 'c1', location_id: 'stillorgan' },
    { id: 'c2', location_id: 'stillorgan' },
  ]
  const activeStudios = [
    { id: 'hatch', name: 'UN1T Hatch Street' },
    { id: 'stillorgan', name: 'UN1T Stillorgan' },
  ]

  it('flags another studio the contact holds a preferences row at', async () => {
    const db = stubFrom({
      contact_location_preferences: () => ({ data: [
        { contact_id: 'c1', location_id: 'stillorgan', email_marketing: true }, // home — uninformative
        { contact_id: 'c1', location_id: 'hatch', email_marketing: true },
      ] }),
      locations: () => ({ data: activeStudios }),
    })
    expect(await fetchListMembershipFlags(db, contacts, active)).toEqual({
      c1: [{ id: 'hatch', name: 'UN1T Hatch Street', emailMarketing: true }],
    })
  })

  it('drops the home studio and the studio being viewed', async () => {
    // Viewing Hatch, contact owned by Stillorgan: the purple crossover pill
    // already says "Stillorgan", and "Hatch" is where we are. Nothing to add.
    const db = stubFrom({
      contact_location_preferences: () => ({ data: [
        { contact_id: 'c2', location_id: 'stillorgan', email_marketing: true },
        { contact_id: 'c2', location_id: 'hatch', email_marketing: true },
      ] }),
      locations: () => ({ data: activeStudios }),
    })
    expect(await fetchListMembershipFlags(db, [{ id: 'c2', location_id: 'stillorgan' }], 'hatch')).toEqual({})
  })

  it('carries email_marketing through so opted-out never looks like opted-in', async () => {
    const db = stubFrom({
      contact_location_preferences: () => ({ data: [
        { contact_id: 'c1', location_id: 'hatch', email_marketing: false },
      ] }),
      locations: () => ({ data: activeStudios }),
    })
    const flags = await fetchListMembershipFlags(db, contacts, active)
    expect(flags.c1[0].emailMarketing).toBe(false)
  })

  it('treats a missing/null email_marketing as opted out, never as opted in', async () => {
    const db = stubFrom({
      contact_location_preferences: () => ({ data: [
        { contact_id: 'c1', location_id: 'hatch', email_marketing: null },
      ] }),
      locations: () => ({ data: activeStudios }),
    })
    expect((await fetchListMembershipFlags(db, contacts, active)).c1[0].emailMarketing).toBe(false)
  })

  it('only names active, non-host-anchor studios', async () => {
    let locFilters = null
    const db = stubFrom({
      contact_location_preferences: () => ({ data: [
        { contact_id: 'c1', location_id: 'ghost', email_marketing: true },
      ] }),
      locations: (calls) => { locFilters = calls.filters; return { data: [] } },
    })
    // 'ghost' resolves to no active studio → no pill rather than a blank one.
    expect(await fetchListMembershipFlags(db, contacts, active)).toEqual({})
    expect(locFilters.active).toBe(true)
    expect(locFilters.is_host_anchor).toBe(false)
  })

  it('sorts pills by studio name so they do not reshuffle between renders', async () => {
    const db = stubFrom({
      contact_location_preferences: () => ({ data: [
        { contact_id: 'c1', location_id: 'zed', email_marketing: true },
        { contact_id: 'c1', location_id: 'hatch', email_marketing: true },
      ] }),
      locations: () => ({ data: [
        { id: 'zed', name: 'UN1T Zed' },
        { id: 'hatch', name: 'UN1T Hatch Street' },
      ] }),
    })
    const flags = await fetchListMembershipFlags(db, contacts, active)
    expect(flags.c1.map((f) => f.name)).toEqual(['UN1T Hatch Street', 'UN1T Zed'])
  })

  it('chunks the id list so the .in() URL cannot 414', async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ id: `c${i}`, location_id: 'stillorgan' }))
    const chunkSizes = []
    const db = stubFrom({
      contact_location_preferences: (calls) => { chunkSizes.push(calls.filters.contact_id.length); return { data: [] } },
      locations: () => ({ data: activeStudios }),
    })
    await fetchListMembershipFlags(db, many, active)
    expect(chunkSizes).toEqual([120, 120, 10])
  })

  it('range-paginates within a chunk so the 1000-row select cap cannot truncate', async () => {
    const ranges = []
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ contact_id: `c${i}`, location_id: 'hatch', email_marketing: true }))
    const db = stubFrom({
      contact_location_preferences: (calls) => {
        ranges.push(calls.range)
        return { data: calls.range[0] === 0
          ? page1
          : [{ contact_id: 'tail', location_id: 'hatch', email_marketing: true }] }
      },
      locations: () => ({ data: activeStudios }),
    })
    const flags = await fetchListMembershipFlags(db, [{ id: 'c0', location_id: 'stillorgan' }], active)
    expect(ranges).toEqual([[0, 999], [1000, 1999]])
    // The row on page 2 is only reachable if pagination actually happened.
    expect(flags.tail).toEqual([{ id: 'hatch', name: 'UN1T Hatch Street', emailMarketing: true }])
  })

  it('skips a contact whose home studio is unknown rather than flagging their own studio', async () => {
    // If either caller's field list ever drops location_id, the failure must
    // be a missing pill, not a pill naming the studio they already belong to.
    const db = stubFrom({
      contact_location_preferences: () => ({ data: [
        { contact_id: 'c9', location_id: 'hatch', email_marketing: true },
      ] }),
      locations: () => ({ data: activeStudios }),
    })
    expect(await fetchListMembershipFlags(db, [{ id: 'c9' }], active)).toEqual({})
  })

  it('is best-effort: {} on no contacts, a preferences error, or a locations error', async () => {
    expect(await fetchListMembershipFlags(stubFrom({}), [], active)).toEqual({})
    expect(await fetchListMembershipFlags(stubFrom({}), null, active)).toEqual({})
    const prefErr = stubFrom({ contact_location_preferences: () => ({ data: null, error: { message: 'boom' } }) })
    expect(await fetchListMembershipFlags(prefErr, contacts, active)).toEqual({})
    const locErr = stubFrom({
      contact_location_preferences: () => ({ data: [{ contact_id: 'c1', location_id: 'hatch', email_marketing: true }] }),
      locations: () => ({ data: null, error: { message: 'boom' } }),
    })
    expect(await fetchListMembershipFlags(locErr, contacts, active)).toEqual({})
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
