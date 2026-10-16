import { describe, it, expect } from 'vitest'
import { resolveUn1tContacts } from './un1t-online-contacts.js'
import { ilikeMatches } from './like-escape.test-helpers.js'

const ORG = 'org-1'
const STILLORGAN = 'loc-stillorgan'
const HATCH = 'loc-hatch'
const NOW = '2026-10-16T10:00:00.000Z'

// A chainable supabase fake over an in-memory `contacts` table. Records every
// call so tests can assert on query shape and write payloads. `.ilike` uses
// the real LIKE semantics (ilikeMatches), not case-insensitive equality.
function makeDb(rows, { failInserts = [], failUpdates = false, zeroRowUpdates = false } = {}) {
  const table = rows.map((r) => ({ ...r }))
  const log = { selects: [], updates: [], inserts: [] }
  let insertCount = 0
  let seq = 0

  function builder(op) {
    const state = { op, filters: [], payload: null, limit: null, columns: null }
    const run = () => {
      if (state.op === 'select') {
        let out = table.filter((row) =>
          state.filters.every(([kind, col, val]) => {
            if (kind === 'eq') return row[col] === val
            if (kind === 'in') return val.includes(row[col])
            if (kind === 'ilike') return ilikeMatches(val, row[col])
            return true
          }),
        )
        if (state.limit != null) out = out.slice(0, state.limit)
        return { data: out.map((r) => ({ ...r })), error: null }
      }
      if (state.op === 'update') {
        if (failUpdates) return { data: null, error: { message: 'update boom' } }
        const id = state.filters.find((f) => f[0] === 'eq' && f[1] === 'id')[2]
        log.updates.push({ id, payload: state.payload, filters: state.filters })
        if (zeroRowUpdates) return { data: [], error: null }
        const row = table.find((r) => r.id === id)
        Object.assign(row, state.payload)
        return { data: [{ id }], error: null }
      }
      // insert
      const n = insertCount
      insertCount += 1
      log.inserts.push(state.payload)
      if (failInserts.includes(n)) return { data: null, error: { message: 'insert boom' } }
      seq += 1
      const row = { id: `new-${seq}`, ...state.payload }
      table.push(row)
      return { data: [{ id: row.id }], error: null }
    }
    const api = {
      select(cols) {
        if (state.op === 'select') {
          state.columns = cols
          log.selects.push(state)
        }
        return api
      },
      eq(col, val) { state.filters.push(['eq', col, val]); return api },
      in(col, val) { state.filters.push(['in', col, val]); return api },
      ilike(col, val) { state.filters.push(['ilike', col, val]); return api },
      limit(n) { state.limit = n; return api },
      update(payload) { state.op = 'update'; state.payload = payload; return api },
      insert(payload) { state.op = 'insert'; state.payload = payload; return api },
      then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject) },
    }
    return api
  }

  const db = { from: (t) => { if (t !== 'contacts') throw new Error(`unexpected table ${t}`); return builder('select') } }
  return { db, table, log }
}

const args = (clients) => ({ locationId: HATCH, organizationId: ORG, clients, now: NOW })

describe('resolveUn1tContacts', () => {
  it('links by un1t_user_id first', async () => {
    const { db, log } = makeDb([
      { id: 'c1', organization_id: ORG, location_id: HATCH, un1t_user_id: 'u1', email: 'a@x.ie', first_name: null, last_name: 'Doe', phone: null },
    ])
    const r = await resolveUn1tContacts(db, args([{ id: 'u1', email: 'a@x.ie', first_name: 'Jane', last_name: 'Other' }]))
    expect(r.counts.linked).toBe(1)
    expect(r.contactIdByUserId.get('u1')).toBe('c1')
    // Only the id lookup ran: no email query.
    expect(log.selects).toHaveLength(1)
    expect(log.selects[0].filters[0][0]).toBe('in')
    // Fills null first_name only; never overwrites last_name.
    expect(log.updates[0].payload).toEqual({ first_name: 'Jane', un1t_synced_at: NOW })
  })

  it('attaches to a Stillorgan contact across studios by email, case-insensitively', async () => {
    const { db, log } = makeDb([
      { id: 'c1', organization_id: ORG, location_id: STILLORGAN, email: 'Jane@x.ie', un1t_user_id: null, first_name: 'Jane', last_name: null, phone: null },
    ])
    const r = await resolveUn1tContacts(db, args([{ id: 'u1', email: 'jane@x.ie', first_name: 'Jane', last_name: 'Doe' }]))
    expect(r.counts.attached_by_email).toBe(1)
    expect(r.counts.created).toBe(0)
    expect(r.contactIdByUserId.get('u1')).toBe('c1')
    const payload = log.updates[0].payload
    expect(payload.un1t_user_id).toBe('u1')
    expect(payload.un1t_synced_at).toBe(NOW)
    expect(payload.last_name).toBe('Doe')
    expect(payload).not.toHaveProperty('location_id')
    expect(payload).not.toHaveProperty('email')
    expect(log.inserts).toHaveLength(0)
  })

  it('does not overwrite an existing name or phone', async () => {
    const { db, log } = makeDb([
      { id: 'c1', organization_id: ORG, location_id: STILLORGAN, email: 'jane@x.ie', un1t_user_id: null, first_name: 'Jane', last_name: 'Doe', phone: '+353871111111' },
    ])
    await resolveUn1tContacts(db, args([{ id: 'u1', email: 'jane@x.ie', first_name: 'Janet', last_name: 'Smith', phone: '+353872222222' }]))
    expect(log.updates[0].payload).toEqual({ un1t_user_id: 'u1', un1t_synced_at: NOW })
  })

  it('two org contacts differing only in case is ambiguous_email', async () => {
    const { db, log } = makeDb([
      { id: 'c1', organization_id: ORG, location_id: STILLORGAN, email: 'Jane@x.ie', un1t_user_id: null },
      { id: 'c2', organization_id: ORG, location_id: HATCH, email: 'jane@x.ie', un1t_user_id: null },
    ])
    const r = await resolveUn1tContacts(db, args([{ id: 'u1', email: 'jane@x.ie' }]))
    expect(r.counts.ambiguous_email).toBe(1)
    expect(r.contactIdByUserId.size).toBe(0)
    expect(log.updates).toHaveLength(0)
    expect(log.inserts).toHaveLength(0)
  })

  it('a contact already linked to another un1t user is a conflict', async () => {
    const { db, log } = makeDb([
      { id: 'c1', organization_id: ORG, location_id: STILLORGAN, email: 'jane@x.ie', un1t_user_id: 'someone-else' },
    ])
    const r = await resolveUn1tContacts(db, args([{ id: 'u1', email: 'jane@x.ie' }]))
    expect(r.counts.conflict).toBe(1)
    expect(r.contactIdByUserId.size).toBe(0)
    expect(log.updates).toHaveLength(0)
    expect(log.inserts).toHaveLength(0)
  })

  it('email lookup is scoped to the organisation, not the location', async () => {
    const { db, log } = makeDb([])
    await resolveUn1tContacts(db, args([{ id: 'u1', email: 'jane@x.ie' }]))
    const emailQuery = log.selects.find((s) => s.filters.some((f) => f[0] === 'ilike'))
    expect(emailQuery.filters).toContainEqual(['eq', 'organization_id', ORG])
    expect(emailQuery.filters.some((f) => f[0] === 'eq' && f[1] === 'location_id')).toBe(false)
    expect(emailQuery.limit).toBe(2)
  })

  it('escapes LIKE wildcards', async () => {
    const { db } = makeDb([
      { id: 'c1', organization_id: ORG, location_id: STILLORGAN, email: 'axb@x.ie', un1t_user_id: null },
    ])
    const r = await resolveUn1tContacts(db, args([{ id: 'u1', email: 'a_b@x.ie' }]))
    expect(r.counts.created).toBe(1)
    expect(r.counts.attached_by_email).toBe(0)
  })

  it('creates with source un1t_online and no consent fields', async () => {
    const { db, log } = makeDb([])
    const r = await resolveUn1tContacts(db, args([{ id: 'u1', email: 'New@X.ie', first_name: 'New', last_name: 'Person', phone: '0871234567' }]))
    expect(r.counts.created).toBe(1)
    expect(r.counts.no_email).toBe(0)
    expect(Object.keys(log.inserts[0]).sort()).toEqual(
      ['location_id', 'source', 'email', 'first_name', 'last_name', 'phone', 'un1t_user_id', 'un1t_synced_at'].sort(),
    )
    expect(log.inserts[0]).toMatchObject({ location_id: HATCH, source: 'un1t_online', email: 'new@x.ie', un1t_user_id: 'u1', un1t_synced_at: NOW })
    expect(r.contactIdByUserId.get('u1')).toBe('new-1')
  })

  it('a client with no email is still inserted and counts as created and no_email', async () => {
    const { db, log } = makeDb([])
    const r = await resolveUn1tContacts(db, args([{ id: 'u1', first_name: 'Name', last_name: 'Only' }]))
    expect(r.counts.created).toBe(1)
    expect(r.counts.no_email).toBe(1)
    expect(log.inserts[0].email).toBeNull()
    // No email lookup for an email-less client.
    expect(log.selects.some((s) => s.filters.some((f) => f[0] === 'ilike'))).toBe(false)
  })

  it('a failed write is counted and the loop continues', async () => {
    const { db } = makeDb([], { failInserts: [0] })
    const r = await resolveUn1tContacts(db, args([
      { id: 'u1', email: 'one@x.ie' },
      { id: 'u2', email: 'two@x.ie' },
    ]))
    expect(r.counts.failed).toBe(1)
    expect(r.counts.created).toBe(1)
    expect(r.errors).toEqual([{ un1t_user_id: 'u1', reason: expect.stringContaining('insert boom') }])
    expect(r.contactIdByUserId.has('u1')).toBe(false)
    expect(r.contactIdByUserId.has('u2')).toBe(true)
  })

  it('a failed update is counted as failed, not as linked', async () => {
    const { db } = makeDb(
      [{ id: 'c1', organization_id: ORG, location_id: HATCH, un1t_user_id: 'u1' }],
      { failUpdates: true },
    )
    const r = await resolveUn1tContacts(db, args([{ id: 'u1' }]))
    expect(r.counts.failed).toBe(1)
    expect(r.counts.linked).toBe(0)
    expect(r.contactIdByUserId.size).toBe(0)
  })

  it('an update that touches no row is failed (a zero-row UPDATE is not an error)', async () => {
    const { db } = makeDb(
      [{ id: 'c1', organization_id: ORG, location_id: HATCH, un1t_user_id: 'u1' }],
      { zeroRowUpdates: true },
    )
    const r = await resolveUn1tContacts(db, args([{ id: 'u1' }]))
    expect(r.counts.failed).toBe(1)
    expect(r.counts.linked).toBe(0)
  })

  it('loads existing links in chunks of 200', async () => {
    const { db, log } = makeDb([])
    const clients = Array.from({ length: 450 }, (_, i) => ({ id: `u${i}` }))
    await resolveUn1tContacts(db, args(clients))
    const inQueries = log.selects.filter((s) => s.filters[0][0] === 'in')
    expect(inQueries.map((q) => q.filters[0][2].length)).toEqual([200, 200, 50])
  })
})
