// FAKEDB.1 — the shared fake database: it refuses what the real one refuses
// and behaves like PostgREST where hand-rolled fakes usually do not.
import { describe, it, expect } from 'vitest'
import { createFakeDb, FakeDbSchemaError } from './helpers/fake-db.js'

const LOC = 'l1'
const seed = () => ({
  locations: [{ id: LOC, name: 'North' }],
  contacts: [
    { id: 'c1', name: 'Ann', email: 'a_b@example.com', location_id: LOC, tags: ['vip', 'new'] },
    { id: 'c2', name: 'Bob', email: 'axb@example.com', location_id: LOC, tags: null },
    { id: 'c3', name: 'Cy', email: null, location_id: 'l2', tags: [] },
  ],
  deals: [{ id: 'd1', contact_id: 'c1', title: 'Deal', location_id: LOC }],
})
const db = (o = {}) => createFakeDb({ tables: seed(), ...o })

describe('schema checks', () => {
  it('refuses unknown tables, including in seed data', () => {
    expect(() => db().from('nope')).toThrow(FakeDbSchemaError)
    expect(() => createFakeDb({ tables: { nope: [] } })).toThrow(/relation 'nope'/)
    expect(() => createFakeDb({ tables: { contacts: [{ nope: 1 }] } })).toThrow(/column 'nope'/)
  })
  it('catches the column that stopped every enrolment', () => {
    expect(() => db().from('sequence_enrollments').select('id, created_at')).toThrow("column 'created_at' does not exist on 'sequence_enrollments'")
  })
  it('checks filters, ordering, writes and embeds', () => {
    expect(() => db().from('contacts').select('id').eq('nope', 1)).toThrow(/nope/)
    expect(() => db().from('contacts').select('id').order('nope')).toThrow(/nope/)
    expect(() => db().from('contacts').update({ nope: 1 })).toThrow(/nope/)
    expect(() => db().from('contacts').insert({ nope: 1 })).toThrow(/nope/)
    expect(() => db().from('deals').select('id, contacts!contact_id(nope)')).toThrow(/'nope' does not exist on 'contacts'/)
  })
  it('checks function names and argument names', async () => {
    await expect(db().rpc('increment_step_sent')).rejects.toThrow(/does not exist/)
    await expect(db().rpc('add_email_storage_bytes', { wrong: 1 })).rejects.toThrow(/no arguments named wrong/)
    const d = db({ rpc: { add_email_storage_bytes: (a) => a.p_delta + 1 } })
    expect(await d.rpc('add_email_storage_bytes', { p_delta: 1 })).toEqual({ data: 2, error: null })
  })
  it('refuses an embed with two possible relationships until it has a hint', () => {
    expect(() => db().from('whatsapp_conversations').select('id, contacts(name)')).toThrow(/PGRST201/)
    expect(() => db().from('whatsapp_conversations').select('id, contacts!contact_id(name)')).not.toThrow()
  })
})

describe('reads', () => {
  it('projects, aliases and embeds both directions', async () => {
    expect((await db().from('deals').select('title, who:contacts!contact_id(name)').eq('id', 'd1').single()).data).toEqual({ title: 'Deal', who: { name: 'Ann' } })
    const { data } = await db().from('contacts').select('name, deals(title)').eq('id', 'c1').maybeSingle()
    expect(data).toEqual({ name: 'Ann', deals: [{ title: 'Deal' }] })
  })
  it('an !inner embed filter drops parents with no match', async () => {
    const { data } = await db().from('contacts').select('id, locations!inner(id)').eq('locations.id', LOC).order('id')
    expect(data.map((r) => r.id)).toEqual(['c1', 'c2'])
  })
  it('NULL matches neither eq nor neq', async () => {
    const q = async (b) => (await b).data.map((r) => r.id)
    expect(await q(db().from('contacts').select('id').neq('email', 'x'))).toEqual(['c1', 'c2'])
    expect(await q(db().from('contacts').select('id').is('email', null))).toEqual(['c3'])
  })
  it('ilike treats _ as a wildcard, as Postgres does', async () => {
    const { data } = await db().from('contacts').select('id').ilike('email', 'a_b@example.com').order('id')
    expect(data.map((r) => r.id)).toEqual(['c1', 'c2'])
  })
  it('reads or() expressions and refuses what it cannot read', async () => {
    const { data } = await db().from('contacts').select('id').or('email.is.null,and(name.eq.Ann,location_id.eq.l1)').order('id')
    expect(data.map((r) => r.id)).toEqual(['c1', 'c3'])
    expect(() => db().from('contacts').select('id').or('nonsense')).toThrow(/cannot read/)
  })
  it('caps every read at 1,000 rows and counts past the cap', async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({ id: `c${i}` }))
    const d = createFakeDb({ tables: { contacts: rows } })
    expect((await d.from('contacts').select('id').limit(5000)).data).toHaveLength(1000)
    expect((await d.from('contacts').select('id').range(1000, 2999)).data).toHaveLength(500)
    expect(await d.from('contacts').select('id', { count: 'exact', head: true })).toMatchObject({ data: null, count: 1500 })
  })
  it('.single() errors unless exactly one row matches; .maybeSingle() allows none', async () => {
    expect((await db().from('contacts').select('id').eq('location_id', LOC).single()).error.code).toBe('PGRST116')
    expect((await db().from('contacts').select('id').eq('id', 'x').single()).error.code).toBe('PGRST116')
    expect(await db().from('contacts').select('id').eq('id', 'x').maybeSingle()).toMatchObject({ data: null, error: null })
  })
})

describe('writes', () => {
  it('updates only matching rows and returns them when asked', async () => {
    const d = db()
    expect((await d.from('contacts').update({ name: 'Z' }).eq('id', 'c1').select('id, name')).data).toEqual([{ id: 'c1', name: 'Z' }])
    expect(d.tables.contacts.find((c) => c.id === 'c2').name).toBe('Bob')
    expect((await d.from('contacts').update({ name: 'Q' }).eq('id', 'none').select('id')).data).toEqual([])
  })
  it('an insert fills an id, and a missing required column fails like Postgres', async () => {
    const d = db()
    expect((await d.from('notes').insert({ contact_id: 'c1', content: 'x' }).select('id').single()).data.id).toMatch(/-/)
    const bad = await d.from('contact_tags').insert({ tag: 'x' })
    expect(bad.error.code).toBe('23502')
  })
  it('upsert updates on the conflict key, and delete removes', async () => {
    const d = db()
    await d.from('contacts').upsert({ id: 'c1', name: 'New' }, { onConflict: 'id' })
    expect(d.tables.contacts.filter((c) => c.id === 'c1')).toHaveLength(1)
    expect(d.tables.contacts[0].name).toBe('New')
    await d.from('contacts').delete().eq('id', 'c1')
    expect(d.tables.contacts.map((c) => c.id)).toEqual(['c2', 'c3'])
  })
  it('an injected failure resolves { error } and has no .catch, like supabase-js', async () => {
    const d = db({ errors: { contacts: { update: { message: 'boom' } } } })
    const q = d.from('contacts').update({ name: 'Z' }).eq('id', 'c1')
    expect(q.catch).toBeUndefined()
    expect(await q).toMatchObject({ data: null, error: { message: 'boom' } })
    expect(d.tables.contacts[0].name).toBe('Ann')
  })
})
