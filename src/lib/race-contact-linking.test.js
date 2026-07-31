import { describe, it, expect } from 'vitest'
import { findOrCreateRaceContact } from './race-contact-linking'

// Minimal chainable db mock. The helper issues two distinct contacts SELECTs:
//   location-scoped: .eq('location_id', X).ilike('email', Y).maybeSingle()
//   global:          .ilike('email', Y).maybeSingle()   (no location filter)
// We tell them apart by whether .eq('location_id', ...) was called on the chain.
function makeDb({ atLocation = null, anywhere = null, insertedId = 'new-id' }) {
  const calls = { globalQueried: false, inserted: null }
  const db = {
    from() {
      let locationFiltered = false
      return {
        select() { return this },
        eq(col) { if (col === 'location_id') locationFiltered = true; return this },
        ilike() { return this },
        maybeSingle: async () => {
          if (locationFiltered) return { data: atLocation }
          calls.globalQueried = true
          return { data: anywhere }
        },
        insert(row) { calls.inserted = row; return { select: () => ({ single: async () => ({ data: { id: insertedId }, error: null }) }) } },
      }
    },
  }
  return { db, calls }
}

const base = { locationId: 'loc-1', email: 'Sam@Example.com', name: 'Sam Lee', phone: '0871234567' }

describe('findOrCreateRaceContact — restrictToLocation', () => {
  it('default: falls back to a global email match across locations', async () => {
    const { db, calls } = makeDb({ atLocation: null, anywhere: { id: 'other-loc-contact' } })
    const id = await findOrCreateRaceContact({ db, ...base })
    expect(id).toBe('other-loc-contact')
    expect(calls.globalQueried).toBe(true)
    expect(calls.inserted).toBeNull()
  })

  it('restrictToLocation: skips the global match and creates within the location', async () => {
    const { db, calls } = makeDb({ atLocation: null, anywhere: { id: 'other-loc-contact' }, insertedId: 'fresh-id' })
    const id = await findOrCreateRaceContact({ db, ...base, restrictToLocation: true })
    expect(id).toBe('fresh-id')
    expect(calls.globalQueried).toBe(false) // never reaches the cross-location query
    expect(calls.inserted).toMatchObject({ location_id: 'loc-1', email: 'sam@example.com' })
  })

  it('still returns a contact already at this location (either mode)', async () => {
    const { db } = makeDb({ atLocation: { id: 'here' }, anywhere: { id: 'other' } })
    expect(await findOrCreateRaceContact({ db, ...base, restrictToLocation: true })).toBe('here')
  })
})

describe('findOrCreateRaceContact — insertFields', () => {
  it('applies insertFields on create only', async () => {
    // No existing match → the contact INSERT payload must include the extras.
    const created = makeDb({ atLocation: null, anywhere: null, insertedId: 'fresh-id' })
    const id = await findOrCreateRaceContact({
      db: created.db, ...base, restrictToLocation: true,
      insertFields: { automations_exempt: true },
    })
    expect(id).toBe('fresh-id')
    expect(created.calls.inserted).toMatchObject({
      location_id: 'loc-1',
      email: 'sam@example.com',
      automations_exempt: true,
    })

    // Existing match → return its id and issue NO insert (matched contacts
    // keep their settings; the mock has no .update so any update would throw).
    const matched = makeDb({ atLocation: { id: 'existing-contact' } })
    const id2 = await findOrCreateRaceContact({
      db: matched.db, ...base, restrictToLocation: true,
      insertFields: { automations_exempt: true },
    })
    expect(id2).toBe('existing-contact')
    expect(matched.calls.inserted).toBeNull()
  })
})
