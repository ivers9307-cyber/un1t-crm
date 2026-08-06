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

// LEADCAP.1 — a mock that models the REAL schema, unlike makeDb above: the
// `contacts_email_unique` index (mig 008) is GLOBAL — UNIQUE (email) WHERE
// email IS NOT NULL, with no location_id — so an email that exists ANYWHERE
// makes the INSERT fail 23505. makeDb's insert always succeeded, which is
// exactly why the prod break below sailed through CI for 38 days.
function makeConstrainedDb({ contacts = [], locations = [] }) {
  const state = { contacts: contacts.map((c) => ({ ...c })), insertAttempts: [] }

  const query = (rows) => {
    const q = {
      _rows: rows,
      select() { return q },
      eq(col, val) { q._rows = q._rows.filter((r) => r[col] === val); return q },
      in(col, vals) { q._rows = q._rows.filter((r) => vals.includes(r[col])); return q },
      ilike(col, val) {
        const want = String(val).toLowerCase()
        q._rows = q._rows.filter((r) => String(r[col] ?? '').toLowerCase() === want)
        return q
      },
      maybeSingle: async () =>
        q._rows.length > 1
          ? { data: null, error: { code: 'PGRST116' } }
          : { data: q._rows[0] || null, error: null },
      then(resolve, reject) { return Promise.resolve({ data: q._rows, error: null }).then(resolve, reject) },
    }
    return q
  }

  const db = {
    from(table) {
      if (table === 'locations') return query(locations)
      const q = query(state.contacts)
      q.insert = (row) => ({
        select: () => ({
          single: async () => {
            state.insertAttempts.push(row)
            const email = String(row.email ?? '').toLowerCase()
            // The global unique index — location_id is NOT part of it.
            if (email && state.contacts.some((c) => String(c.email ?? '').toLowerCase() === email)) {
              return {
                data: null,
                error: { code: '23505', message: 'duplicate key value violates unique constraint "contacts_email_unique"' },
              }
            }
            const created = { id: `new-${state.contacts.length + 1}`, ...row }
            state.contacts.push(created)
            return { data: created, error: null }
          },
        }),
      })
      return q
    },
  }
  return { db, state }
}

const ORG_UN1T = 'org-un1t'
const ORG_CCF = 'org-ccf'
const STILLORGAN = 'loc-stillorgan'
const HATCH = 'loc-hatch'
const CCF = 'loc-ccf'
const LOCATIONS = [
  { id: STILLORGAN, organization_id: ORG_UN1T },
  { id: HATCH, organization_id: ORG_UN1T },
  { id: CCF, organization_id: ORG_CCF },
]

describe('findOrCreateRaceContact — restrictToOrg (LEADCAP.1)', () => {
  it('links an existing sibling-location contact instead of a doomed INSERT', async () => {
    // The live break: Garrett is on file at Stillorgan and signs up for the
    // Hatch Street waitlist. Under restrictToLocation this INSERTed into the
    // global unique index, 23505'd, and 500'd the form.
    const { db, state } = makeConstrainedDb({
      contacts: [{ id: 'stillorgan-contact', location_id: STILLORGAN, email: 'garrett07@hotmail.com' }],
      locations: LOCATIONS,
    })

    const id = await findOrCreateRaceContact({
      db, locationId: HATCH, email: 'Garrett07@hotmail.com', name: 'Garrett Ivers', restrictToOrg: true,
    })

    expect(id).toBe('stillorgan-contact')
    expect(state.insertAttempts).toHaveLength(0) // never attempt an insert we know will fail
  })

  it('never links across organisations (the IDOR the location restriction closed)', async () => {
    // Same email, but the only holder belongs to a DIFFERENT tenant. We must
    // not resolve it — no consent/deal may be written against another org.
    const { db } = makeConstrainedDb({
      contacts: [{ id: 'ccf-contact', location_id: CCF, email: 'shared@example.com' }],
      locations: LOCATIONS,
    })

    const id = await findOrCreateRaceContact({
      db, locationId: HATCH, email: 'shared@example.com', name: 'Someone', restrictToOrg: true,
    })

    expect(id).not.toBe('ccf-contact')
    expect(id).toBeNull() // the global index still blocks the insert; fail closed, never cross tenants
  })

  it('still creates a fresh contact for a brand-new email', async () => {
    const { db, state } = makeConstrainedDb({ contacts: [], locations: LOCATIONS })

    const id = await findOrCreateRaceContact({
      db, locationId: HATCH, email: 'brand-new@example.com', name: 'New Person', restrictToOrg: true,
    })

    expect(id).toBe('new-1')
    expect(state.insertAttempts).toHaveLength(1)
    expect(state.insertAttempts[0]).toMatchObject({ location_id: HATCH, email: 'brand-new@example.com' })
  })

  it('prefers a contact already at this location over a sibling one', async () => {
    const { db } = makeConstrainedDb({
      contacts: [{ id: 'hatch-contact', location_id: HATCH, email: 'dup@example.com' }],
      locations: LOCATIONS,
    })

    const id = await findOrCreateRaceContact({
      db, locationId: HATCH, email: 'dup@example.com', name: 'X', restrictToOrg: true,
    })

    expect(id).toBe('hatch-contact')
  })

  it('recovers from a concurrent insert of the same email in-org (23505 race)', async () => {
    // Two rapid submits: the org lookup misses, then the INSERT loses the race.
    // Re-checking in-org must find the winner rather than 500 the visitor.
    const { db, state } = makeConstrainedDb({ contacts: [], locations: LOCATIONS })
    const original = db.from
    let firstLook = true
    db.from = (table) => {
      const q = original(table)
      if (table === 'contacts' && firstLook) {
        const realMaybe = q.maybeSingle
        q.maybeSingle = async () => {
          firstLook = false
          // Simulate the racing request landing between our lookup and insert.
          state.contacts.push({ id: 'race-winner', location_id: HATCH, email: 'race@example.com' })
          return realMaybe.call(q)
        }
      }
      return q
    }

    const id = await findOrCreateRaceContact({
      db, locationId: HATCH, email: 'race@example.com', name: 'Racer', restrictToOrg: true,
    })

    expect(id).toBe('race-winner')
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
