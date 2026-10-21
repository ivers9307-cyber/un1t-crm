// ORGCONTACTS.2 — the one query the contacts list and /api/contacts/search
// build: public.studio_contacts (mig 765) filtered on the studio, never an
// id.in() list of crossover ids (the 100-id cap and the 414 are gone).
import { describe, it, expect } from 'vitest'
import { CONTACT_LIST_FIELDS, listStudioContactsQuery, countStudioContactsQuery } from './studio-contacts-query.js'

function fakeDb() {
  const calls = []
  return {
    calls,
    from(table) {
      const call = { table, select: null, options: null, filters: [] }
      calls.push(call)
      const b = {
        select(cols, opts) { call.select = cols; call.options = opts ?? null; return b },
        eq(c, v) { call.filters.push(['eq', c, v]); return b },
        or(s) { call.filters.push(['or', s]); return b },
        in(c, v) { call.filters.push(['in', c, v]); return b },
      }
      return b
    },
  }
}
const LOC = 'a0000000-0000-4000-8000-000000000001'

describe('listStudioContactsQuery', () => {
  it('reads studio_contacts filtered on studio_location_id, with the list fields plus the crossover flag; primaryOnly folds linked people', () => {
    const db = fakeDb()
    listStudioContactsQuery(db, { locationId: LOC, primaryOnly: true })
    const [c] = db.calls
    expect(c.table).toBe('studio_contacts')
    expect(c.select).toBe(`${CONTACT_LIST_FIELDS}, studio_is_crossover`)
    expect(c.filters).toEqual([['eq', 'studio_location_id', LOC], ['eq', 'is_primary_contact', true]])
    expect(c.filters.some((f) => f[0] === 'or')).toBe(false)
  })
  it('without primaryOnly every account shows; the location filter is always first', () => {
    const db = fakeDb()
    listStudioContactsQuery(db, { locationId: LOC })
    expect(db.calls[0].filters).toEqual([['eq', 'studio_location_id', LOC]])
  })
  it('refuses a missing studio', () => {
    expect(() => listStudioContactsQuery(fakeDb(), { locationId: null })).toThrow(/locationId/)
  })
})

describe('countStudioContactsQuery', () => {
  it('is the same WHERE as a head count', () => {
    const db = fakeDb()
    countStudioContactsQuery(db, { locationId: LOC, primaryOnly: true })
    const [c] = db.calls
    expect(c.table).toBe('studio_contacts')
    expect(c.select).toBe('id')
    expect(c.options).toEqual({ count: 'exact', head: true })
    expect(c.filters).toEqual([['eq', 'studio_location_id', LOC], ['eq', 'is_primary_contact', true]])
  })
})
