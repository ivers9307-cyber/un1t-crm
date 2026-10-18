import { describe, it, expect, vi } from 'vitest'
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect((await crossoverContactIds(db, 'loc1')).length).toBe(CROSSOVER_ID_CAP)
      // structured logWarn: the location and the counts, never a contact id
      expect(warn).toHaveBeenCalledTimes(1)
      const logged = JSON.stringify(warn.mock.calls[0])
      expect(logged).toContain('contact-crossovers')
      expect(logged).toContain('loc1')
      expect(logged).toContain(String(CROSSOVER_ID_CAP + 50))
      expect(logged).not.toMatch(/"c\d+"/)
    } finally {
      warn.mockRestore()
    }
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
  // contact_memberships stub: no membership rows unless a test says so.
  // un1t_clients stub: no client rows unless a test says so.
  const dealStub = (rows, memberships = [], clients = []) => stubFrom({
    deals: () => ({ data: rows }),
    contact_memberships: () => ({ data: memberships }),
    un1t_clients: () => ({ data: clients }),
  })

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

  describe('UN1TDUAL.2 — active membership at one of the caller studios', () => {
    // staff hold Contacts by role default (web and phone)
    const user = { isMaster: false, locations: [{ id: 'L1', role: 'staff' }] }
    const contact = { id: 'c1', location_id: 'L2' }

    it('opens a contact with an active membership at one of the user\'s studios', async () => {
      let seen = null
      const db = stubFrom({
        contact_memberships: (calls) => { seen = calls; return { data: [{ id: 'm1' }] } },
        // deals would deny: proves the membership branch alone grants access.
        un1t_clients: () => { throw new Error('should not be probed after a membership grants') },
        deals: () => ({ data: [] }),
      })
      expect(await canViewContact(db, user, contact)).toBe(true)
      expect(seen.filters).toMatchObject({ contact_id: 'c1', status: 'active', location_id: ['L1'] })
      expect(seen.limit).toBe(1)
    })
    it('an ended membership does not open it', async () => {
      // The query filters status = active, so an ended row comes back empty.
      let seen = null
      const db = stubFrom({
        contact_memberships: (calls) => { seen = calls; return { data: [] } },
        un1t_clients: () => ({ data: [] }),
        deals: () => ({ data: [] }),
      })
      expect(await canViewContact(db, user, contact)).toBe(false)
      expect(seen.filters.status).toBe('active')
    })
    it('a membership read error fails closed when there is no deal', async () => {
      const db = stubFrom({
        contact_memberships: () => ({ data: null, error: { code: '42501', message: 'boom' } }),
        un1t_clients: () => ({ data: [] }),
        deals: () => ({ data: [] }),
      })
      expect(await canViewContact(db, user, contact)).toBe(false)
    })
    it('a membership read error still opens a deal crossover', async () => {
      const db = stubFrom({
        contact_memberships: () => ({ data: null, error: { code: '42501', message: 'boom' } }),
        un1t_clients: () => ({ data: [] }),
        deals: () => ({ data: [{ id: 'd1' }] }),
      })
      expect(await canViewContact(db, user, contact)).toBe(true)
    })
    it('a thrown membership read fails closed', async () => {
      const db = stubFrom({
        contact_memberships: () => { throw new Error('network') },
        deals: () => ({ data: [{ id: 'd1' }] }),
      })
      expect(await canViewContact(db, user, contact)).toBe(false)
    })
    it('owner / master / deal branches are unchanged', async () => {
      const noMembership = (rows) => stubFrom({
        contact_memberships: () => ({ data: [] }),
        un1t_clients: () => ({ data: [] }),
        deals: () => ({ data: rows }),
      })
      expect(await canViewContact(null, { isMaster: true }, contact)).toBe(true)
      expect(await canViewContact(noMembership([]), { isMaster: false, locations: [{ id: 'L2' }] }, contact)).toBe(true)
      expect(await canViewContact(noMembership([{ id: 'd1' }]), user, contact)).toBe(true)
      expect(await canViewContact(noMembership([]), user, contact)).toBe(false)
    })
    it('never probes memberships for master, owner, or a caller with no studios', async () => {
      const db = stubFrom({
        contact_memberships: () => { throw new Error('should not be probed') },
      })
      expect(await canViewContact(db, { isMaster: true }, contact)).toBe(true)
      expect(await canViewContact(db, { isMaster: false, locations: [{ id: 'L2' }] }, contact)).toBe(true)
      expect(await canViewContact(db, { isMaster: false, locations: [] }, contact)).toBe(false)
    })
  })

  describe('UN1TDUAL.4 — a un1t.online client of one of the caller studios', () => {
    const user = { isMaster: false, locations: [{ id: 'L1', role: 'staff' }, { id: 'L3', role: 'manager' }] }
    const contact = { id: 'c1', location_id: 'L2' }
    const err = { data: null, error: { code: '42501', message: 'boom' } }

    it('opens a contact linked as a un1t client at one of the user\'s studios', async () => {
      let seen = null
      const db = stubFrom({
        contact_memberships: () => ({ data: [] }),
        un1t_clients: (calls) => { seen = calls; return { data: [{ id: 'u1' }] } },
        // deals would deny: proves the client branch alone grants access.
        deals: () => ({ data: [] }),
      })
      expect(await canViewContact(db, user, contact)).toBe(true)
      expect(seen.filters).toEqual({ contact_id: 'c1', location_id: ['L1', 'L3'] })
      // any un1t status counts: the probe never filters on it
      expect(seen.filters).not.toHaveProperty('status')
      expect(seen.limit).toBe(1)
    })
    it('a client row at another studio does not open it', async () => {
      // The query is scoped to the caller's studios, so a row at L2 comes back empty.
      let seen = null
      const db = stubFrom({
        contact_memberships: () => ({ data: [] }),
        un1t_clients: (calls) => { seen = calls; return { data: [] } },
        deals: () => ({ data: [] }),
      })
      expect(await canViewContact(db, user, contact)).toBe(false)
      expect(seen.filters.location_id).toEqual(['L1', 'L3'])
    })
    it('a un1t_clients read error falls through to the deal probe and never grants', async () => {
      const noDeal = stubFrom({ contact_memberships: () => ({ data: [] }), un1t_clients: () => err, deals: () => ({ data: [] }) })
      expect(await canViewContact(noDeal, user, contact)).toBe(false)
      // an error that also carries rows still never grants
      const errWithRows = stubFrom({
        contact_memberships: () => ({ data: [] }),
        un1t_clients: () => ({ data: [{ id: 'u1' }], error: { code: '500', message: 'boom' } }),
        deals: () => ({ data: [] }),
      })
      expect(await canViewContact(errWithRows, user, contact)).toBe(false)
      const deal = stubFrom({ contact_memberships: () => ({ data: [] }), un1t_clients: () => err, deals: () => ({ data: [{ id: 'd1' }] }) })
      expect(await canViewContact(deal, user, contact)).toBe(true)
    })
    it('a un1t_clients read error never hides a membership crossover (the membership probe runs first)', async () => {
      const db = stubFrom({
        contact_memberships: () => ({ data: [{ id: 'm1' }] }),
        un1t_clients: () => err,
        deals: () => ({ data: [] }),
      })
      expect(await canViewContact(db, user, contact)).toBe(true)
    })
    it('a membership read error still lets a client row open it', async () => {
      const db = stubFrom({
        contact_memberships: () => err,
        un1t_clients: () => ({ data: [{ id: 'u1' }] }),
        deals: () => ({ data: [] }),
      })
      expect(await canViewContact(db, user, contact)).toBe(true)
    })
    it('a thrown un1t_clients read fails closed', async () => {
      const db = stubFrom({
        contact_memberships: () => ({ data: [] }),
        un1t_clients: () => { throw new Error('network') },
        deals: () => ({ data: [{ id: 'd1' }] }),
      })
      expect(await canViewContact(db, user, contact)).toBe(false)
    })
    it('never probes un1t_clients for master, owner, or a caller with no studios', async () => {
      const db = stubFrom({
        contact_memberships: () => ({ data: [] }),
        un1t_clients: () => { throw new Error('should not be probed') },
      })
      expect(await canViewContact(db, { isMaster: true }, contact)).toBe(true)
      expect(await canViewContact(db, { isMaster: false, locations: [{ id: 'L2' }] }, contact)).toBe(true)
      expect(await canViewContact(db, { isMaster: false, locations: [] }, contact)).toBe(false)
    })
  })

  describe('UN1TDUAL.4 fix — the membership and client probes judge Contacts like RLS does', () => {
    // A Stillorgan contact (L2) opened by Hatch (L1) staff.
    const contact = { id: 'c1', location_id: 'L2' }
    const hatch = (permissions, extra = {}) => ({
      isMaster: false,
      locations: [{ id: 'L1', role: 'staff', ...extra }],
      assignmentsByLocation: { L1: { role: 'staff', permissions } },
    })
    const NO_CONTACTS = { contacts: false, mobile: { contacts: false } }
    const seen = []
    const db = ({ membership = [], client = [], deal = [] } = {}) => stubFrom({
      contact_memberships: (calls) => { seen.push(calls); return { data: membership } },
      un1t_clients: (calls) => { seen.push(calls); return { data: client } },
      deals: (calls) => { seen.push(calls); return { data: deal } },
    })
    const tables = () => seen.map((c) => c.table)

    it('a member of Hatch WITHOUT Contacts there cannot open it via a Hatch membership or a Hatch un1t client', async () => {
      seen.length = 0
      expect(await canViewContact(db({ membership: [{ id: 'm1' }] }), hatch(NO_CONTACTS), contact)).toBe(false)
      expect(await canViewContact(db({ client: [{ id: 'u1' }] }), hatch(NO_CONTACTS), contact)).toBe(false)
      // both probes are skipped outright; only the deal probe ran
      expect(tables()).toEqual(['deals', 'deals'])
    })
    it('…but still can via a Hatch deal (the deal probe is unchanged)', async () => {
      expect(await canViewContact(db({ deal: [{ id: 'd1' }] }), hatch(NO_CONTACTS), contact)).toBe(true)
    })
    it('Contacts switched off for the studio (the location gate) skips the probes too', async () => {
      seen.length = 0
      const user = hatch({}, { features: { contacts: false } })
      expect(await canViewContact(db({ membership: [{ id: 'm1' }], client: [{ id: 'u1' }] }), user, contact)).toBe(false)
      expect(tables()).toEqual(['deals'])
    })
    it('a role template that switches Contacts off (web and phone) skips the probes', async () => {
      const user = { ...hatch({}), roleTemplatesByLocation: { L1: { contacts: false, mobile: { contacts: false } } } }
      expect(await canViewContact(db({ membership: [{ id: 'm1' }], client: [{ id: 'u1' }] }), user, contact)).toBe(false)
    })
    it('phone-only Contacts at Hatch can open it via a membership or a client', async () => {
      const phoneOnly = hatch({ contacts: false, mobile: { contacts: true } })
      expect(await canViewContact(db({ membership: [{ id: 'm1' }] }), phoneOnly, contact)).toBe(true)
      expect(await canViewContact(db({ client: [{ id: 'u1' }] }), phoneOnly, contact)).toBe(true)
    })
    it('web-only Contacts at Hatch can open it too', async () => {
      const webOnly = hatch({ contacts: true, mobile: { contacts: false } })
      expect(await canViewContact(db({ client: [{ id: 'u1' }] }), webOnly, contact)).toBe(true)
    })
    it('the probes ask only about the studios where the caller holds Contacts; the deal probe about all of them', async () => {
      seen.length = 0
      const user = {
        isMaster: false,
        locations: [{ id: 'L1', role: 'staff' }, { id: 'L3', role: 'staff' }],
        assignmentsByLocation: { L1: { role: 'staff', permissions: {} }, L3: { role: 'staff', permissions: NO_CONTACTS } },
      }
      expect(await canViewContact(db(), user, contact)).toBe(false)
      expect(seen.map((c) => [c.table, c.filters.location_id])).toEqual([
        ['contact_memberships', ['L1']],
        ['un1t_clients', ['L1']],
        ['deals', ['L1', 'L3']],
      ])
    })
    it('a caller with no role anywhere (Contacts nowhere) never reaches the probes', async () => {
      const db2 = stubFrom({
        contact_memberships: () => { throw new Error('should not be probed') },
        un1t_clients: () => { throw new Error('should not be probed') },
        deals: () => ({ data: [] }),
      })
      expect(await canViewContact(db2, { isMaster: false, locations: [{ id: 'L1' }] }, contact)).toBe(false)
    })
  })
})

// UN1TRADAR.3 — the radar write routes accept a crossover at the ACTIVE studio
// only (a membership or un1t client there), and fail closed.
describe('isCrossoverAt / crossoverIdsAt', () => {
  function probeDb(tables, { fail = [] } = {}) {
    const log = []
    return {
      log,
      from(table) {
        const s = { table, filters: [] }
        const b = {
          select: () => b,
          eq(c, v) { s.filters.push(['eq', c, v]); return b },
          in(c, v) { s.filters.push(['in', c, v]); return b },
          order: () => b,
          range: () => b,
          limit: () => b,
          then(res, rej) {
            log.push(s)
            if (fail.includes(table)) return Promise.resolve({ data: null, error: { code: 'X', message: 'boom' } }).then(res, rej)
            const rows = (tables[table] || []).filter((r) => s.filters.every(([k, c, v]) => (k === 'eq' ? r[c] === v : v.includes(r[c]))))
            return Promise.resolve({ data: rows, error: null }).then(res, rej)
          },
        }
        return b
      },
    }
  }
  const HATCH = 'loc-hatch'
  const STILL = 'loc-still'
  const tables = {
    contact_memberships: [{ id: 'm1', contact_id: 'c-mem', location_id: HATCH, status: 'active' }, { id: 'm2', contact_id: 'c-ended', location_id: HATCH, status: 'ended' }],
    un1t_clients: [{ id: 'u1', contact_id: 'c-client', location_id: HATCH }],
  }

  it('crossover accepted at its membership studio', async () => {
    const { isCrossoverAt } = await import('./contact-crossovers')
    expect(await isCrossoverAt(probeDb(tables), 'c-mem', HATCH)).toBe(true)
    expect(await isCrossoverAt(probeDb(tables), 'c-ended', HATCH)).toBe(false)
  })
  it('crossover via a un1t_clients row accepted', async () => {
    const { isCrossoverAt } = await import('./contact-crossovers')
    expect(await isCrossoverAt(probeDb(tables), 'c-client', HATCH)).toBe(true)
  })
  it('refused at any other studio', async () => {
    const { isCrossoverAt } = await import('./contact-crossovers')
    expect(await isCrossoverAt(probeDb(tables), 'c-mem', STILL)).toBe(false)
  })
  it('probe error fails closed', async () => {
    const { isCrossoverAt } = await import('./contact-crossovers')
    expect(await isCrossoverAt(probeDb(tables, { fail: ['contact_memberships', 'un1t_clients'] }), 'c-mem', HATCH)).toBe(false)
    expect(await isCrossoverAt({ from() { throw new Error('down') } }, 'c-mem', HATCH)).toBe(false)
    expect(await isCrossoverAt(probeDb(tables), null, HATCH)).toBe(false)
  })
  it('crossoverIdsAt: both probes at the active studio only; any error → empty set', async () => {
    const { crossoverIdsAt } = await import('./contact-crossovers')
    const db = probeDb(tables)
    expect(await crossoverIdsAt(db, ['c-mem', 'c-client', 'c-ended', 'c-none'], HATCH)).toEqual(new Set(['c-mem', 'c-client']))
    for (const q of db.log) expect(q.filters).toContainEqual(['eq', 'location_id', HATCH])
    expect(await crossoverIdsAt(probeDb(tables), ['c-mem'], STILL)).toEqual(new Set())
    expect(await crossoverIdsAt(probeDb(tables, { fail: ['un1t_clients'] }), ['c-mem', 'c-client'], HATCH)).toEqual(new Set())
    expect(await crossoverIdsAt(probeDb(tables), [], HATCH)).toEqual(new Set())
  })
})
