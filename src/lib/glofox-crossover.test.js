// GLOFOXSIBLING.1 — the organisation-wide Glofox contact resolver and the
// crossover link write.
import { describe, it, expect } from 'vitest'
import {
  findGlofoxCrossoverContact, recordGlofoxCrossover, glofoxCrossoverContactIds, glofoxStudioOrCrossoverFilter,
  scopeToGlofoxStudio, glofoxLinkLocationsByContact, contactAtGlofoxStudio, MAX_SCOPE_IDS,
} from './glofox-crossover.js'
import { ilikeMatches } from './like-escape.test-helpers.js'

// A small table-aware fake: every query records (table, op, filters, payload)
// and resolves from `tables`, honouring eq / ilike (as PostgREST would: a
// pattern, so the escape is exercised) / limit / maybeSingle.
function fakeDb(tables = {}, { errors = {} } = {}) {
  const calls = []
  const from = (table) => {
    const q = { table, op: 'select', filters: [], payload: null, single: false, limit: null }
    const chain = {}
    chain.select = () => chain
    chain.eq = (col, val) => { q.filters.push(['eq', col, val]); return chain }
    chain.ilike = (col, val) => { q.filters.push(['ilike', col, val]); return chain }
    chain.in = (col, vals) => { q.filters.push(['in', col, vals]); return chain }
    chain.gt = (col, val) => { q.filters.push(['gt', col, val]); return chain }
    chain.limit = (n) => { q.limit = n; return chain }
    chain.maybeSingle = () => { q.single = true; return chain }
    for (const op of ['insert', 'upsert', 'update']) chain[op] = (payload) => { q.op = op; q.payload = payload; return chain }
    chain.then = (resolve) => {
      calls.push(q)
      const err = errors[`${table}:${q.op}`]
      if (err) return resolve({ data: null, error: err })
      if (q.op === 'upsert' && table === 'contact_location_preferences') return resolve({ data: q.payload.map((r) => ({ contact_id: r.contact_id })), error: null })
      if (q.op === 'upsert' && table === 'contact_studios') return resolve({ data: [{ contact_id: q.payload.contact_id, location_id: q.payload.location_id, kind: q.payload.kind }], error: null })
      if (q.op !== 'select') return resolve({ data: null, error: null })
      let rows = (tables[table] || []).filter((r) => q.filters.every(([kind, col, val]) =>
        kind === 'eq' ? r[col] === val : kind === 'ilike' ? ilikeMatches(r[col], val) : kind === 'in' ? val.includes(r[col]) : true))
      if (q.limit != null) rows = rows.slice(0, q.limit)
      resolve({ data: q.single ? (rows[0] ?? null) : rows, error: null })
    }
    return chain
  }
  return { from, calls }
}

const LOC = 'stillorgan'
const base = () => ({
  locations: [{ id: LOC, organization_id: 'org-1' }, { id: 'hatch', organization_id: 'org-1' }],
  contacts: [
    { id: 'c-hatch', location_id: 'hatch', organization_id: 'org-1', email: 'Craig@X.com', glofox_member_id: null },
    { id: 'c-other-org', location_id: 'elsewhere', organization_id: 'org-2', email: 'dana@x.com', glofox_member_id: 'g-dana' },
  ],
})

describe('findGlofoxCrossoverContact', () => {
  it('finds the organisation contact by email, case-insensitively', async () => {
    const out = await findGlofoxCrossoverContact(fakeDb(base()), LOC, { glofoxMemberId: 'g1', email: 'craig@x.com' })
    expect(out).toMatchObject({ contact: { id: 'c-hatch', location_id: 'hatch' }, how: 'email' })
  })

  it('escapes the email: `_` matches only itself, so a lookalike address is not matched', async () => {
    const t = base()
    t.contacts.push({ id: 'c-lookalike', location_id: 'hatch', organization_id: 'org-1', email: 'axb@x.com', glofox_member_id: null })
    const out = await findGlofoxCrossoverContact(fakeDb(t), LOC, { email: 'a_b@x.com' })
    expect(out.contact).toBeNull()
  })

  it('never crosses the organisation', async () => {
    const out = await findGlofoxCrossoverContact(fakeDb(base()), LOC, { glofoxMemberId: 'g-dana', email: 'dana@x.com' })
    expect(out.contact).toBeNull()
    expect(out.conflict).toBeUndefined()
  })

  // ORGCONTACTS.5 (mig 768) — the link a previous sync gave IS the contact_studios
  // row with source glofox at the studio, read through the studio_contacts view
  // (a contacts row joined to its relationship rows).
  it('prefers the contact whose contact_studios row at the studio has source glofox', async () => {
    const t = base()
    t.studio_contacts = [{ id: 'c-hatch', location_id: 'hatch', organization_id: 'org-1', glofox_member_id: 'g1', studio_location_id: LOC, studio_source: 'glofox' }]
    const read = fakeDb(t)
    const out = await findGlofoxCrossoverContact(read, LOC, { glofoxMemberId: 'g1' })
    expect(out).toMatchObject({ contact: { id: 'c-hatch' }, how: 'link' })
    const q = read.calls.find((c) => c.table === 'studio_contacts')
    expect(q.filters).toEqual(expect.arrayContaining([['eq', 'studio_location_id', LOC], ['eq', 'glofox_member_id', 'g1'], ['eq', 'studio_source', 'glofox']]))
    expect(read.calls.some((c) => c.table === 'glofox_crossover_members')).toBe(false)
  })

  it('finds by Glofox member id anywhere in the organisation (booking events carry no email)', async () => {
    const t = base()
    t.contacts[0].glofox_member_id = 'g1'
    const out = await findGlofoxCrossoverContact(fakeDb(t), LOC, { glofoxMemberId: 'g1' })
    expect(out).toMatchObject({ contact: { id: 'c-hatch' }, how: 'glofox_member_id' })
  })

  it('an email holder linked to a different Glofox member is a conflict, not a match', async () => {
    const t = base()
    t.contacts[0].glofox_member_id = 'g-other'
    const out = await findGlofoxCrossoverContact(fakeDb(t), LOC, { glofoxMemberId: 'g1', email: 'craig@x.com' })
    expect(out.contact).toBeNull()
    expect(out.conflict).toMatchObject({ contact_ids: ['c-hatch'] })
  })

  it('the id on one contact and the email on another is a conflict', async () => {
    const t = base()
    t.contacts.push({ id: 'c-id', location_id: 'hatch', organization_id: 'org-1', email: 'other@x.com', glofox_member_id: 'g1' })
    const out = await findGlofoxCrossoverContact(fakeDb(t), LOC, { glofoxMemberId: 'g1', email: 'craig@x.com' })
    expect(out.conflict.contact_ids.sort()).toEqual(['c-hatch', 'c-id'])
  })

  it('a failed read is an error, never "no contact"', async () => {
    for (const key of ['studio_contacts:select', 'locations:select', 'contacts:select']) {
      const out = await findGlofoxCrossoverContact(fakeDb(base(), { errors: { [key]: { message: 'down' } } }), LOC, { glofoxMemberId: 'g1', email: 'craig@x.com' })
      expect(out.contact, key).toBeNull()
      expect(out.error, key).toMatch(/down/)
    }
  })

  it('the view not existing yet (code before mig 765) is "no link", not an error', async () => {
    for (const code of ['PGRST205', '42P01']) {
      const db = fakeDb(base(), { errors: { 'studio_contacts:select': { code, message: 'missing' } } })
      const out = await findGlofoxCrossoverContact(db, LOC, { glofoxMemberId: 'g1', email: 'craig@x.com' })
      expect(out, code).toMatchObject({ contact: { id: 'c-hatch' }, how: 'email' })
    }
  })

  it('a location with no organisation is an error', async () => {
    const out = await findGlofoxCrossoverContact(fakeDb({ locations: [{ id: LOC, organization_id: null }] }), LOC, { email: 'craig@x.com' })
    expect(out.error).toMatch(/no organisation/)
  })

  it('nothing to look up: no contact, no query', async () => {
    const db = fakeDb(base())
    expect(await findGlofoxCrossoverContact(db, LOC, {})).toEqual({ contact: null })
    expect(db.calls).toEqual([])
  })
})

describe('recordGlofoxCrossover', () => {
  it('links the contact at the studio (the contact_studios row, source glofox: mig 768 dropped the link table) and gives it the studio preferences row (consent source glofox_sync)', async () => {
    const db = fakeDb({ contacts: base().contacts, contact_location_preferences: [], contact_preferences: [] })
    const out = await recordGlofoxCrossover(db, { locationId: LOC, glofoxMemberId: 'g1', contactId: 'c-hatch' })
    expect(out).toEqual({ linked: true, preferences_created: 1, contact_studio: { ok: true } })
    expect(db.calls.some((c) => c.table === 'glofox_crossover_members')).toBe(false)
    const row = db.calls.find((c) => c.table === 'contact_studios' && c.op === 'upsert')
    expect(row.payload).toMatchObject({ location_id: LOC, contact_id: 'c-hatch', source: 'glofox' })
    const prefs = db.calls.find((c) => c.table === 'contact_location_preferences' && c.op === 'upsert')
    expect(prefs.payload[0]).toMatchObject({ contact_id: 'c-hatch', location_id: LOC, source: 'glofox_sync' })
    const log = db.calls.find((c) => c.table === 'consent_log' && c.op === 'insert')
    expect(log.payload.every((r) => r.source === 'glofox_sync' && r.location_id === LOC)).toBe(true)
  })

  it('a contact living at the studio needs no link', async () => {
    const db = fakeDb(base())
    const out = await recordGlofoxCrossover(db, { locationId: 'hatch', glofoxMemberId: 'g1', contactId: 'c-hatch' })
    expect(out).toMatchObject({ linked: false, skipped: 'contact lives at this studio' })
    expect(db.calls.some((c) => c.op === 'upsert')).toBe(false)
  })

  it('a failed relationship write is reported as the link failing, and no preferences row is made', async () => {
    const db = fakeDb(base(), { errors: { 'contact_studios:upsert': { message: 'relation does not exist' } } })
    const out = await recordGlofoxCrossover(db, { locationId: LOC, glofoxMemberId: 'g1', contactId: 'c-hatch', contactLocationId: 'hatch' })
    expect(out.linked).toBe(false)
    expect(out.error).toMatch(/relation does not exist/)
    expect(out.contact_studio).toMatchObject({ ok: false })
    expect(db.calls.some((c) => c.table === 'contact_location_preferences')).toBe(false)
  })

  // ORGCONTACTS.1 — the relationship row (mig 764) beside the link row.
  it('also writes the contact_studios row at the Glofox studio: client by default, member when the contact row says so', async () => {
    const db = fakeDb({ contacts: base().contacts, contact_location_preferences: [], contact_preferences: [] })
    const out = await recordGlofoxCrossover(db, { locationId: LOC, glofoxMemberId: 'g1', contactId: 'c-hatch', contactLocationId: 'hatch' })
    expect(out.contact_studio).toEqual({ ok: true })
    const row = db.calls.find((c) => c.table === 'contact_studios' && c.op === 'upsert')
    expect(row.payload).toMatchObject({ contact_id: 'c-hatch', location_id: LOC, kind: 'client', status: 'active', source: 'glofox', ended_at: null })
    expect(row.payload).not.toHaveProperty('last_seen_at')

    const member = fakeDb({ contacts: base().contacts, contact_location_preferences: [], contact_preferences: [] })
    await recordGlofoxCrossover(member, {
      locationId: LOC, glofoxMemberId: 'g1', contactId: 'c-hatch', contactLocationId: 'hatch',
      contactRow: { glofox_membership_status: 'member', glofox_membership_state: 'active', joined_at: '2026-02-01T00:00:00.000Z' },
    })
    const mrow = member.calls.find((c) => c.table === 'contact_studios' && c.op === 'upsert')
    expect(mrow.payload.kind).toBe('member')
    const seen = member.calls.find((c) => c.table === 'contact_studios' && c.op === 'update')
    expect(seen.payload).toEqual({ first_seen_at: '2026-02-01T00:00:00.000Z' })
  })

  it('skips the contact_studios row (and writes nothing) for a contact living at the studio', async () => {
    const here = fakeDb(base())
    const skipped = await recordGlofoxCrossover(here, { locationId: 'hatch', glofoxMemberId: 'g1', contactId: 'c-hatch' })
    expect(skipped.contact_studio).toBeUndefined()
    expect(here.calls.some((c) => c.table === 'contact_studios')).toBe(false)
  })
})

// GLOFOXREADERS.1 — the reader helpers.
describe('reader helpers (ORGCONTACTS.2: read contact_studios)', () => {
  // The fake honours eq / in on contact_studios and ignores order / range.
  const studioDb = (rows, { error = null } = {}) => {
    const db = fakeDb({ contact_studios: rows }, error ? { errors: { 'contact_studios:select': error } } : {})
    const from = db.from
    db.from = (table) => { const c = from(table); c.order = () => c; c.range = () => c; return c }
    return db
  }
  const row = (contact_id, location_id, over = {}) => ({ contact_id, location_id, kind: 'client', status: 'active', source: 'glofox', ...over })

  // GLOFOX414.1 — the ids ride in the request URL, so only the true crossovers.
  const viewDb = (rows, { error = null } = {}) => {
    const db = fakeDb({ studio_contacts: rows }, error ? { errors: { 'studio_contacts:select': error } } : {})
    const from = db.from
    db.from = (table) => { const c = from(table); c.order = () => c; c.range = () => c; return c }
    return db
  }
  const viewRow = (id, studio_location_id, over = {}) => ({ id, studio_location_id, studio_source: 'glofox', studio_is_crossover: true, ...over })

  it('glofoxCrossoverContactIds lists only the crossover contacts with a Glofox relationship at the studio (deduped); a failed read is an error', async () => {
    const db = viewDb([
      viewRow('c1', LOC), viewRow('c1', LOC),
      viewRow('c-home', LOC, { studio_is_crossover: false }),
      viewRow('c2', LOC, { studio_source: 'un1t_online' }),
      viewRow('c3', 'hatch'),
    ])
    expect(await glofoxCrossoverContactIds(db, LOC)).toEqual({ ids: ['c1'] })
    expect((await glofoxCrossoverContactIds(viewDb([], { error: { message: 'down' } }), LOC)).error).toMatch(/down/)
  })

  it('glofoxCrossoverContactIds refuses more ids than a request URL can carry (an error, never a 414)', async () => {
    const many = Array.from({ length: MAX_SCOPE_IDS + 1 }, (_, i) => viewRow(`c${i}`, LOC))
    const out = await glofoxCrossoverContactIds(viewDb(many), LOC)
    expect(out.ids).toEqual([])
    expect(out.error).toMatch(/more than/)
    const ok = await glofoxCrossoverContactIds(viewDb(many.slice(0, MAX_SCOPE_IDS)), LOC)
    expect(ok.ids).toHaveLength(MAX_SCOPE_IDS)
  })

  it('glofoxStudioOrCrossoverFilter / scopeToGlofoxStudio', () => {
    expect(glofoxStudioOrCrossoverFilter(LOC, [])).toBeNull()
    expect(glofoxStudioOrCrossoverFilter(LOC, ['a', 'b'])).toBe(`location_id.eq.${LOC},id.in.(a,b)`)
    const calls = []
    const q = { eq: (...a) => { calls.push(['eq', ...a]); return q }, or: (...a) => { calls.push(['or', ...a]); return q } }
    scopeToGlofoxStudio(q, LOC, [])
    scopeToGlofoxStudio(q, LOC, ['a'])
    expect(calls).toEqual([['eq', 'location_id', LOC], ['or', `location_id.eq.${LOC},id.in.(a)`]])
  })

  it('glofoxLinkLocationsByContact maps each contact to the studios it has a Glofox relationship at (home included)', async () => {
    const db = studioDb([row('c1', LOC), row('c1', 'other'), row('c2', LOC), row('c2', 'hatch', { source: 'un1t_online' })])
    const out = await glofoxLinkLocationsByContact(db, ['c1', 'c2', 'c3'])
    expect(out.error).toBeUndefined()
    expect(Object.fromEntries(out.byContact)).toEqual({ c1: [LOC, 'other'], c2: [LOC] })
    expect((await glofoxLinkLocationsByContact(studioDb([], { error: { message: 'down' } }), ['c1'])).error).toMatch(/down/)
  })

  it('contactAtGlofoxStudio: home or a studio_location_ids entry', () => {
    expect(contactAtGlofoxStudio({ location_id: LOC }, LOC)).toBe(true)
    expect(contactAtGlofoxStudio({ location_id: 'hatch', studio_location_ids: [LOC] }, LOC)).toBe(true)
    expect(contactAtGlofoxStudio({ location_id: 'hatch' }, LOC)).toBe(false)
    expect(contactAtGlofoxStudio(null, LOC)).toBe(false)
  })
})
