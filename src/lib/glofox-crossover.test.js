// GLOFOXSIBLING.1 — the organisation-wide Glofox contact resolver and the
// crossover link write.
import { describe, it, expect } from 'vitest'
import { findGlofoxCrossoverContact, recordGlofoxCrossover } from './glofox-crossover.js'
import { ilikeMatches } from './like-escape.test-helpers.js'

// A small table-aware fake: every query records (table, op, filters, payload)
// and resolves from `tables`, honouring eq / ilike (as PostgREST would: a
// pattern, so the escape is exercised) / limit / maybeSingle.
function fakeDb(tables = {}, { errors = {}, upsertReturns = null } = {}) {
  const calls = []
  const from = (table) => {
    const q = { table, op: 'select', filters: [], payload: null, single: false, limit: null }
    const chain = {}
    chain.select = () => chain
    chain.eq = (col, val) => { q.filters.push(['eq', col, val]); return chain }
    chain.ilike = (col, val) => { q.filters.push(['ilike', col, val]); return chain }
    chain.in = (col, vals) => { q.filters.push(['in', col, vals]); return chain }
    chain.limit = (n) => { q.limit = n; return chain }
    chain.maybeSingle = () => { q.single = true; return chain }
    for (const op of ['insert', 'upsert', 'update']) chain[op] = (payload) => { q.op = op; q.payload = payload; return chain }
    chain.then = (resolve) => {
      calls.push(q)
      const err = errors[`${table}:${q.op}`]
      if (err) return resolve({ data: null, error: err })
      if (q.op === 'upsert' && table === 'glofox_crossover_members') return resolve({ data: upsertReturns ?? [{ id: 'gx-1' }], error: null })
      if (q.op === 'upsert' && table === 'contact_location_preferences') return resolve({ data: q.payload.map((r) => ({ contact_id: r.contact_id })), error: null })
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

  it('prefers the studio link row', async () => {
    const t = base()
    t.glofox_crossover_members = [{ location_id: LOC, glofox_member_id: 'g1', contact_id: 'c-hatch' }]
    const out = await findGlofoxCrossoverContact(fakeDb(t), LOC, { glofoxMemberId: 'g1' })
    expect(out).toMatchObject({ contact: { id: 'c-hatch' }, how: 'link' })
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
    for (const key of ['glofox_crossover_members:select', 'locations:select', 'contacts:select']) {
      const out = await findGlofoxCrossoverContact(fakeDb(base(), { errors: { [key]: { message: 'down' } } }), LOC, { glofoxMemberId: 'g1', email: 'craig@x.com' })
      expect(out.contact, key).toBeNull()
      expect(out.error, key).toMatch(/down/)
    }
  })

  it('the link table not existing yet (code before mig 758) is "no link", not an error', async () => {
    for (const code of ['PGRST205', '42P01']) {
      const db = fakeDb(base(), { errors: { 'glofox_crossover_members:select': { code, message: 'missing' } } })
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
  it('links the contact at the studio and gives it the studio preferences row (consent source glofox_sync)', async () => {
    const db = fakeDb({ contacts: base().contacts, contact_location_preferences: [], contact_preferences: [] })
    const out = await recordGlofoxCrossover(db, { locationId: LOC, glofoxMemberId: 'g1', contactId: 'c-hatch' })
    expect(out).toEqual({ linked: true, preferences_created: 1 })
    const link = db.calls.find((c) => c.table === 'glofox_crossover_members' && c.op === 'upsert')
    expect(link.payload).toMatchObject({ location_id: LOC, glofox_member_id: 'g1', contact_id: 'c-hatch' })
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

  it('a failed link write is reported, and no preferences row is made', async () => {
    const db = fakeDb(base(), { errors: { 'glofox_crossover_members:upsert': { message: 'relation does not exist' } } })
    const out = await recordGlofoxCrossover(db, { locationId: LOC, glofoxMemberId: 'g1', contactId: 'c-hatch', contactLocationId: 'hatch' })
    expect(out.linked).toBe(false)
    expect(out.error).toMatch(/relation does not exist/)
    expect(db.calls.some((c) => c.table === 'contact_location_preferences')).toBe(false)
  })

  it('a link write that touched no row is an error', async () => {
    const db = fakeDb(base(), { upsertReturns: [] })
    const out = await recordGlofoxCrossover(db, { locationId: LOC, glofoxMemberId: 'g1', contactId: 'c-hatch', contactLocationId: 'hatch' })
    expect(out.error).toMatch(/no row/)
  })
})
