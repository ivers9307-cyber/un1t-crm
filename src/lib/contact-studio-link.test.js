import { describe, it, expect, vi } from 'vitest'
import { contactIdsLinkedToStudio, contactInStudioOrganisation } from './contact-studio-link.js'

const HATCH = 'hatch'
const STILL = 'stillorgan'

// tables: { [table]: rows[] | { error } }. Filters are applied for real so a
// test fails if the helper forgets to scope a read to the studio.
function fakeDb(tables) {
  return {
    from: vi.fn((table) => {
      const filters = []
      const b = {
        select: () => b,
        eq: (col, v) => { filters.push((r) => r[col] === v); return b },
        in: (col, vs) => { filters.push((r) => vs.includes(r[col])); return b },
        order: () => b,
        range: () => b,
        maybeSingle: () => {
          const t = tables[table]
          if (t?.error) return Promise.resolve({ data: null, error: t.error })
          return Promise.resolve({ data: (t || []).find((r) => filters.every((f) => f(r))) ?? null, error: null })
        },
        then: (onF) => {
          const t = tables[table]
          if (t?.error) return Promise.resolve({ data: null, error: t.error }).then(onF)
          return Promise.resolve({ data: (t || []).filter((r) => filters.every((f) => f(r))), error: null }).then(onF)
        },
      }
      return b
    }),
  }
}

const base = {
  locations: [
    { id: HATCH, organization_id: 'org-1' },
    { id: STILL, organization_id: 'org-1' },
    { id: 'other', organization_id: 'org-2' },
  ],
  contacts: [
    { id: 'h1', location_id: HATCH, organization_id: 'org-1' },
    { id: 's-deal', location_id: STILL, organization_id: 'org-1' },
    { id: 's-pref', location_id: STILL, organization_id: 'org-1' },
    { id: 's-none', location_id: STILL, organization_id: 'org-1' },
    { id: 'x-org', location_id: 'other', organization_id: 'org-2' },
  ],
  // ORGCONTACTS.2 — "joined this studio" is a contact_studios row there, any kind or status.
  contact_studios: [
    { contact_id: 's-deal', location_id: HATCH, kind: 'lead', status: 'active' },
    { contact_id: 's-pref', location_id: HATCH, kind: 'lead', status: 'ended' },
    { contact_id: 's-none', location_id: STILL, kind: 'lead', status: 'active' }, // its HOME studio only
    { contact_id: 'x-org', location_id: HATCH, kind: 'lead', status: 'active' }, // stray row across organisations
  ],
}

describe('contactIdsLinkedToStudio (SHAREDCONTACT.1)', () => {
  it('admits own contacts and sibling contacts who joined the studio, in input order', async () => {
    const r = await contactIdsLinkedToStudio(fakeDb(base), {
      locationId: HATCH,
      contactIds: ['s-pref', 'h1', 's-none', 's-deal', 'x-org', 'missing'],
    })
    expect(r).toEqual({ ok: true, ids: ['s-pref', 'h1', 's-deal'], joined: ['s-pref', 's-deal'] })
  })

  it('never admits a contact of another organisation, even with a deal on the board', async () => {
    const r = await contactIdsLinkedToStudio(fakeDb(base), { locationId: HATCH, contactIds: ['x-org'] })
    expect(r).toEqual({ ok: true, ids: [], joined: [] })
  })

  it('a sibling studio with no deal or preference row there is not joined', async () => {
    const r = await contactIdsLinkedToStudio(fakeDb(base), { locationId: HATCH, contactIds: ['s-none'] })
    expect(r.ids).toEqual([])
  })

  it('reports a failed read instead of answering "nobody"', async () => {
    const r = await contactIdsLinkedToStudio(fakeDb({ ...base, contact_studios: { error: { message: 'boom' } } }), {
      locationId: HATCH, contactIds: ['s-deal'],
    })
    expect(r).toMatchObject({ ok: false, reason: 'links_unreadable' })
    const r2 = await contactIdsLinkedToStudio(fakeDb({ ...base, contacts: { error: { message: 'boom' } } }), {
      locationId: HATCH, contactIds: ['h1'],
    })
    expect(r2).toMatchObject({ ok: false, reason: 'contacts_unreadable' })
  })

  it('an unknown studio is refused', async () => {
    const r = await contactIdsLinkedToStudio(fakeDb(base), { locationId: 'nope', contactIds: ['h1'] })
    expect(r).toEqual({ ok: false, reason: 'no_location' })
  })

  it('an empty list reads nothing', async () => {
    const db = fakeDb(base)
    expect(await contactIdsLinkedToStudio(db, { locationId: HATCH, contactIds: [] })).toEqual({ ok: true, ids: [], joined: [] })
    expect(db.from).not.toHaveBeenCalled()
  })
})

describe('contactInStudioOrganisation', () => {
  it('home studio needs no read', async () => {
    const db = fakeDb(base)
    expect(await contactInStudioOrganisation(db, { contact: base.contacts[0], locationId: HATCH })).toEqual({ ok: true, sameStudio: true })
    expect(db.from).not.toHaveBeenCalled()
  })
  it('a sibling studio in the same organisation is allowed', async () => {
    expect(await contactInStudioOrganisation(fakeDb(base), { contact: base.contacts[1], locationId: HATCH }))
      .toEqual({ ok: true, sameStudio: false })
  })
  it('another organisation is refused', async () => {
    expect(await contactInStudioOrganisation(fakeDb(base), { contact: base.contacts[4], locationId: HATCH }))
      .toEqual({ ok: false, reason: 'cross_organisation' })
  })
})
