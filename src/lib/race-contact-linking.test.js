import { describe, it, expect } from 'vitest'
import { findOrCreateRaceContact } from './race-contact-linking'
import { ilikeMatches } from './like-escape.test-helpers'

// Minimal chainable db mock for the restrictToLocation path only (it never
// reaches the org lookup, so no `locations` rows are modelled). A contacts
// SELECT is location-scoped when .eq('location_id', …) or .in('location_id', …)
// was called on the chain; any other contacts .maybeSingle() is an estate-wide
// lookup, which W0.6 removed — `globalQueried` records one.
function makeDb({ atLocation = null, anywhere = null, insertedId = 'new-id' }) {
  const calls = { globalQueried: false, inserted: null }
  const db = {
    from() {
      let locationFiltered = false
      return {
        select() { return this },
        eq(col) { if (col === 'location_id') locationFiltered = true; return this },
        in(col) { if (col === 'location_id') locationFiltered = true; return this },
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
  it('restrictToLocation: skips the sibling-location match and creates within the location', async () => {
    const { db, calls } = makeDb({ atLocation: null, anywhere: { id: 'other-loc-contact' }, insertedId: 'fresh-id' })
    const id = await findOrCreateRaceContact({ db, ...base, restrictToLocation: true })
    expect(id).toBe('fresh-id')
    expect(calls.globalQueried).toBe(false) // never reaches any cross-location query
    expect(calls.inserted).toMatchObject({ location_id: 'loc-1', email: 'sam@example.com' })
  })

  it('still returns a contact already at this location (either mode)', async () => {
    const { db } = makeDb({ atLocation: { id: 'here' }, anywhere: { id: 'other' } })
    expect(await findOrCreateRaceContact({ db, ...base, restrictToLocation: true })).toBe('here')
  })
})

// LEADCAP.1 / W0.6 — a mock that models the REAL schema, unlike makeDb above:
// `contacts_email_org_unique` (mig 712) is UNIQUE (organization_id, email)
// WHERE email IS NOT NULL — the row's organisation is its location's — so an
// email that exists anywhere in the SAME organisation makes the INSERT fail
// 23505, while another tenant's identical email does not. (Mig 008's index
// was global, which is why a known email once 500'd a sibling studio's form
// for 38 days under makeDb's always-succeeding insert.) It also counts every
// contacts lookup issued with NO location filter — the estate-wide fallback
// W0.6 removed, since a match outside the org is another tenant's person.
function makeConstrainedDb({ contacts = [], locations = [] }) {
  const state = { contacts: contacts.map((c) => ({ ...c })), insertAttempts: [], unscopedContactLookups: 0 }
  const orgOf = (row) => locations.find((l) => l.id === row.location_id)?.organization_id ?? null

  const query = (rows, { trackScope = false } = {}) => {
    let scoped = false
    const q = {
      _rows: rows,
      select() { return q },
      eq(col, val) { if (col === 'location_id') scoped = true; q._rows = q._rows.filter((r) => r[col] === val); return q },
      in(col, vals) { if (col === 'location_id') scoped = true; q._rows = q._rows.filter((r) => vals.includes(r[col])); return q },
      // Real LIKE semantics, not lower(a) === lower(b): the equality form is
      // what the call site MEANS but not what Postgres does, and modelling it
      // as equality is what let the 2026-08-07 wildcard bug through a green
      // suite. See src/lib/like-escape.test-helpers.js.
      ilike(col, val) {
        q._rows = q._rows.filter((r) => ilikeMatches(val, r[col]))
        return q
      },
      maybeSingle: async () => {
        if (trackScope && !scoped) state.unscopedContactLookups += 1
        return q._rows.length > 1
          ? { data: null, error: { code: 'PGRST116' } }
          : { data: q._rows[0] || null, error: null }
      },
      then(resolve, reject) { return Promise.resolve({ data: q._rows, error: null }).then(resolve, reject) },
    }
    return q
  }

  const db = {
    from(table) {
      if (table === 'locations') return query(locations)
      const q = query(state.contacts, { trackScope: true })
      q.insert = (row) => ({
        select: () => ({
          single: async () => {
            state.insertAttempts.push(row)
            const email = String(row.email ?? '').toLowerCase()
            const org = orgOf(row)
            // The per-organisation unique index: same org AND same email
            // (a NULL organisation never collides, as in Postgres).
            if (email && org && state.contacts.some((c) => orgOf(c) === org && String(c.email ?? '').toLowerCase() === email)) {
              return {
                data: null,
                error: { code: '23505', message: 'duplicate key value violates unique constraint "contacts_email_org_unique"' },
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

  it('never links across organisations; the same email gets its OWN contact in this org (W0.6)', async () => {
    // Same email, but the only holder belongs to a DIFFERENT tenant. We must
    // not resolve it — no consent/deal may be written against another org —
    // and under the per-org index (mig 712) nothing stops this org holding
    // its own row for that person, where mig 008's global index 500'd.
    const { db, state } = makeConstrainedDb({
      contacts: [{ id: 'ccf-contact', location_id: CCF, email: 'shared@example.com' }],
      locations: LOCATIONS,
    })

    const id = await findOrCreateRaceContact({
      db, locationId: HATCH, email: 'shared@example.com', name: 'Someone', restrictToOrg: true,
    })

    expect(id).not.toBe('ccf-contact')
    expect(id).toBe('new-2') // the fixture's second row
    expect(state.insertAttempts).toHaveLength(1)
    expect(state.insertAttempts[0]).toMatchObject({ location_id: HATCH, email: 'shared@example.com' })
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

// W0.6 — org-wide is now the DEFAULT and the widest any caller resolves.
// Before, a caller passing neither flag (team rosters, event registration)
// fell through to an estate-wide lookup: a match at another tenant was
// linked as if it were this person.
describe('findOrCreateRaceContact — default scope is the organisation (W0.6)', () => {
  it('links a sibling-location contact through an org-scoped lookup, never an estate-wide one', async () => {
    const { db, state } = makeConstrainedDb({
      contacts: [{ id: 'stillorgan-contact', location_id: STILLORGAN, email: 'x@example.com' }],
      locations: LOCATIONS,
    })

    const id = await findOrCreateRaceContact({ db, locationId: HATCH, email: 'x@example.com', name: 'X' })

    expect(id).toBe('stillorgan-contact')
    expect(state.unscopedContactLookups).toBe(0)
    expect(state.insertAttempts).toHaveLength(0)
  })

  it('never links another organisation\'s contact: it creates this org\'s own row', async () => {
    const { db, state } = makeConstrainedDb({
      contacts: [{ id: 'ccf-contact', location_id: CCF, email: 'x@example.com' }],
      locations: LOCATIONS,
    })

    const id = await findOrCreateRaceContact({ db, locationId: HATCH, email: 'x@example.com', name: 'X' })

    expect(id).toBe('new-2') // the fixture's second row
    expect(state.unscopedContactLookups).toBe(0)
    expect(state.insertAttempts[0]).toMatchObject({ location_id: HATCH, email: 'x@example.com' })
  })

  it('a 23505 on insert re-checks in-org and adopts the concurrent winner (no flag needed)', async () => {
    const { db, state } = makeConstrainedDb({ contacts: [], locations: LOCATIONS })
    const original = db.from
    let firstLook = true
    db.from = (table) => {
      const q = original(table)
      if (table === 'contacts' && firstLook) {
        const realMaybe = q.maybeSingle
        q.maybeSingle = async () => {
          firstLook = false
          state.contacts.push({ id: 'race-winner', location_id: STILLORGAN, email: 'race@example.com' })
          return realMaybe.call(q)
        }
      }
      return q
    }

    const id = await findOrCreateRaceContact({ db, locationId: HATCH, email: 'race@example.com', name: 'Racer' })

    expect(id).toBe('race-winner')
  })

  it('a 23505 with no in-org holder returns null rather than linking anywhere else', async () => {
    // The index refused the row but nothing in this org holds the email: the
    // only explanation is a row outside the organisation (or a half-applied
    // schema). Fail closed; never resolve it to another tenant's person.
    const { db, state } = makeConstrainedDb({
      contacts: [{ id: 'ccf-contact', location_id: CCF, email: 'x@example.com' }],
      locations: LOCATIONS,
    })
    const original = db.from
    db.from = (table) => {
      const q = original(table)
      if (table === 'contacts') {
        q.insert = (row) => ({ select: () => ({ single: async () => {
          state.insertAttempts.push(row)
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "contacts_email_org_unique"' } }
        } }) })
      }
      return q
    }

    const id = await findOrCreateRaceContact({ db, locationId: HATCH, email: 'x@example.com', name: 'X' })

    expect(id).toBeNull()
    expect(state.insertAttempts).toHaveLength(1)
    expect(state.unscopedContactLookups).toBe(0)
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

// ── LIKE wildcards in a public-form email (2026-08-07) ──────────────
// Every caller of findOrCreateRaceContact on a public route (leads,
// class-booking, host-list subscribe, event/race register) passes an
// operator-untrusted email. The lookups used a bare .ilike(), so the pattern —
// not the address — decided which contact got linked. See src/lib/like-escape.js.
describe('findOrCreateRaceContact — LIKE wildcards cannot select a contact', () => {
  it('an address containing "_" does not link a DIFFERENT contact', async () => {
    const { db, state } = makeConstrainedDb({
      contacts: [{ id: 'lookalike', location_id: STILLORGAN, email: 'axb@example.com' }],
      locations: LOCATIONS,
    })

    const id = await findOrCreateRaceContact({
      db, locationId: STILLORGAN, email: 'a_b@example.com', name: 'Ada B', restrictToOrg: true,
    })

    expect(id).not.toBe('lookalike')
    // No match → a new contact is created for the real address.
    expect(state.insertAttempts).toHaveLength(1)
    expect(state.insertAttempts[0]).toMatchObject({ email: 'a_b@example.com' })
  })

  it('"%@domain" does not link every contact at that domain', async () => {
    const { db, state } = makeConstrainedDb({
      contacts: [
        { id: 'alice', location_id: STILLORGAN, email: 'alice@example.com' },
        { id: 'bob', location_id: STILLORGAN, email: 'bob@example.com' },
      ],
      locations: LOCATIONS,
    })

    const id = await findOrCreateRaceContact({
      db, locationId: STILLORGAN, email: '%@example.com', name: 'Nobody', restrictToOrg: true,
    })

    expect(id).not.toBe('alice')
    expect(id).not.toBe('bob')
    expect(state.insertAttempts[0]).toMatchObject({ email: '%@example.com' })
  })

  it('"%@%.%" does not reach across organisations on the default (org) path', async () => {
    // The unrestricted path used to query contacts with NO location filter, so
    // an unescaped wildcard there could link any contact in the estate; the
    // org-scoped lookup must not either.
    const { db, state } = makeConstrainedDb({
      contacts: [{ id: 'ccf-contact', location_id: CCF, email: 'buyer@ccfautos.com' }],
      locations: LOCATIONS,
    })

    const id = await findOrCreateRaceContact({
      db, locationId: STILLORGAN, email: '%@%.%', name: 'Nobody',
    })

    expect(id).not.toBe('ccf-contact')
    expect(state.unscopedContactLookups).toBe(0)
  })

  it('still links a genuine mixed-case match (escaping is behaviour-preserving)', async () => {
    const { db, state } = makeConstrainedDb({
      contacts: [{ id: 'real', location_id: STILLORGAN, email: 'Garrett07@Hotmail.com' }],
      locations: LOCATIONS,
    })

    const id = await findOrCreateRaceContact({
      db, locationId: STILLORGAN, email: 'garrett07@hotmail.com', name: 'Garrett', restrictToOrg: true,
    })

    expect(id).toBe('real')
    expect(state.insertAttempts).toHaveLength(0)
  })

  it('still links an address that genuinely contains an underscore', async () => {
    const { db, state } = makeConstrainedDb({
      contacts: [{ id: 'underscored', location_id: STILLORGAN, email: 'a_b@example.com' }],
      locations: LOCATIONS,
    })

    const id = await findOrCreateRaceContact({
      db, locationId: STILLORGAN, email: 'a_b@example.com', name: 'Ada B', restrictToOrg: true,
    })

    expect(id).toBe('underscored')
    expect(state.insertAttempts).toHaveLength(0)
  })
})
