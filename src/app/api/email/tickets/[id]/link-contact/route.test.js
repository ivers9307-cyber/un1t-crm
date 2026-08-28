// EMAIL-CONTACT-CHIP.2 — "Add to contacts" on an unlinked thread.
//
// Gated through the same loadTicketForUser chain as every other ticket
// mutation route (status, assign, participants): 404 for a ticket the caller
// cannot see, whatever the reason. Linking itself goes through
// findOrCreateRaceContact with restrictToOrg: true — the house LEADCAP.1
// create-or-link helper — so these tests prove this route calls it correctly
// (match-first, create-on-miss, org-scoped) rather than re-testing the
// helper's own internals (covered in race-contact-linking.test.js).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
// Wraps the REAL implementation (vi.fn(actual.fn) delegates through), so
// every other test in this file still exercises genuine match/create/23505
// behaviour — this only adds a call-args spy so the org-scope flag itself is
// pinned by an assertion, not just by the org-lookup happening to be a no-op
// against this fixture set (baseState seeds no `locations` rows, so a
// restrictToOrg: false mutation would NOT fail any of the tests above).
vi.mock('@/lib/race-contact-linking', async () => {
  const actual = await vi.importActual('@/lib/race-contact-linking')
  return { ...actual, findOrCreateRaceContact: vi.fn(actual.findOrCreateRaceContact) }
})

import { POST } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { findOrCreateRaceContact } from '@/lib/race-contact-linking'
import { makeDb, writesTo, insertsInto, updatesTo, failWrites } from '../../_test-db'
import {
  T_STUDIO, T_ACCOUNTS, T_OTHER_LOCATION, COACH, COACH_NO_INBOX, GRANT_STUDIO, MB_ACCOUNTS, baseState, LOC_A,
} from '../../_test-fixtures'

// The coach's studio@ grant alone cannot see T_ACCOUNTS (that split is the
// whole point of the fixture, per _test-fixtures.js) — these tests are about
// the link, not about mailbox visibility (already proven above and in every
// sibling route's own suite), so the coach is additionally granted
// accounts@ here.
const GRANT_ACCOUNTS = { mailbox_id: MB_ACCOUNTS.id, profile_id: COACH.id }

function post(id) {
  return POST(
    new Request(`http://x/api/email/tickets/${id}/link-contact`, { method: 'POST' }),
    { params: Promise.resolve({ id }) }
  )
}

let db
function setupDb(extra = {}) {
  db = makeDb(baseState({ grants: [GRANT_STUDIO, GRANT_ACCOUNTS], ...extra }))
  createServerClient.mockImplementation(() => db)
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(COACH)
  setupDb()
})

describe('POST …/link-contact — gates', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post(T_ACCOUNTS.id)).status).toBe(401)
  })

  // Same 404 posture as every sibling ticket-mutation route: a caller who
  // holds the mailbox grant but lacks email_inbox AT THE TICKET'S location
  // is refused indistinguishably from a bad id.
  it('404s without the email_inbox permission at the ticket’s location, writing nothing', async () => {
    getCurrentUser.mockResolvedValue(COACH_NO_INBOX)
    expect((await post(T_ACCOUNTS.id)).status).toBe(404)
    expect(writesTo(db)).toEqual([])
  })

  it('404s on a ticket at a foreign location', async () => {
    setupDb({ tickets: [{ ...T_STUDIO }, { ...T_ACCOUNTS }, { ...T_OTHER_LOCATION }] })
    expect((await post(T_OTHER_LOCATION.id)).status).toBe(404)
    expect(writesTo(db)).toEqual([])
  })

  it('404s on a ticket that does not exist', async () => {
    expect((await post('00000000-0000-4000-8000-000000000000')).status).toBe(404)
  })
})

describe('POST …/link-contact — creates + links', () => {
  it('creates a contact when no existing contact matches, and links it', async () => {
    // T_ACCOUNTS: contact_id null, requester_email payer@example.com — no
    // contacts fixture carries that email anywhere in baseState.
    const res = await post(T_ACCOUNTS.id)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.contact.email).toBe('payer@example.com')

    // Exactly one contact created, at the ticket's own location.
    const created = insertsInto(db, 'contacts')
    expect(created).toHaveLength(1)
    expect(created[0].payload.location_id).toBe(LOC_A)
    expect(created[0].payload.email).toBe('payer@example.com')
    // H1 (audit finding) — this contact is NOT a race signup. Every field the
    // helper's own hard-coded default would otherwise stamp is pinned here so
    // a dropped insertFields fails loudly rather than quietly reverting to
    // name: 'Race competitor', source: 'race_signup', lead_source: 'website'.
    expect(created[0].payload.name).toBe('Bob Payer')
    expect(created[0].payload.source).toBe('email_inbox')
    expect(created[0].payload.lead_source).toBeNull()

    // The ticket row now carries it.
    const newContactId = db._state.contacts.find(c => c.email === 'payer@example.com').id
    expect(body.data.contact.id).toBe(newContactId)
    const ticketWrite = updatesTo(db, 'email_tickets').find(u => u.filters.some(f => f[0] === 'eq' && f[1] === 'id' && f[2] === T_ACCOUNTS.id))
    expect(ticketWrite.payload.contact_id).toBe(newContactId)
  })

  // H1 — the audit finding this suite exists to pin. requester_name is NULL
  // for every sender whose From header carries no display name (routine for
  // suppliers and bare user@domain senders). Without insertFields overriding
  // the helper's own `name || 'Race competitor'` default, that contact would
  // be permanently misnamed.
  it('falls the contact name back to the email when requester_name is null — never "Race competitor"', async () => {
    setupDb({ tickets: [{ ...T_ACCOUNTS, requester_name: null }] })
    const res = await post(T_ACCOUNTS.id)
    expect(res.status).toBe(200)
    const created = insertsInto(db, 'contacts')
    expect(created).toHaveLength(1)
    expect(created[0].payload.name).toBe('payer@example.com')
    expect(created[0].payload.name).not.toBe('Race competitor')
  })

  // H1 — insertFields must apply ONLY on create. Linking an EXISTING contact
  // must never touch its name/source, whatever the ticket's requester_name is.
  it('leaves an existing contact\'s name/source untouched on the link path (insertFields is create-only)', async () => {
    const existing = { id: 'existing-contact-1', location_id: LOC_A, email: 'payer@example.com', name: 'Bob The Payer', source: 'manual' }
    setupDb({ contacts: [existing], tickets: [{ ...T_ACCOUNTS, requester_name: null }] })
    const res = await post(T_ACCOUNTS.id)
    expect(res.status).toBe(200)
    expect(insertsInto(db, 'contacts')).toHaveLength(0)
    const row = db._state.contacts.find(c => c.id === 'existing-contact-1')
    expect(row.name).toBe('Bob The Payer')
    expect(row.source).toBe('manual')
  })

  it('LINKS AN EXISTING contact on an email match — no duplicate', async () => {
    const existing = { id: 'existing-contact-1', location_id: LOC_A, email: 'payer@example.com', name: 'Bob Payer' }
    setupDb({ contacts: [existing] })

    const res = await post(T_ACCOUNTS.id)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.contact.id).toBe('existing-contact-1')

    // The global-unique behaviour this route exists to respect: no second
    // contacts row for the same email.
    expect(insertsInto(db, 'contacts')).toHaveLength(0)
    expect(db._state.contacts).toHaveLength(1)

    const ticketWrite = updatesTo(db, 'email_tickets')[0]
    expect(ticketWrite.payload.contact_id).toBe('existing-contact-1')
  })

  it('backfills contact_id onto the ticket’s own messages that have none, mirroring ingest', async () => {
    setupDb({
      messages: [
        { id: 'm1', ticket_id: T_ACCOUNTS.id, contact_id: null, location_id: LOC_A, direction: 'inbound' },
        { id: 'm2', ticket_id: T_ACCOUNTS.id, contact_id: null, location_id: LOC_A, direction: 'outbound' },
        // A different ticket's message must never be touched by this write.
        { id: 'm3', ticket_id: T_STUDIO.id, contact_id: null, location_id: LOC_A, direction: 'inbound' },
        // Already carries a DIFFERENT contact (e.g. a forwarded copy on this
        // same ticket, filed under someone else) — the .is('contact_id',
        // null) guard must never clobber it.
        { id: 'm4', ticket_id: T_ACCOUNTS.id, contact_id: 'someone-else', location_id: LOC_A, direction: 'inbound' },
      ],
    })
    await post(T_ACCOUNTS.id)
    const linkedId = db._state.contacts.find(c => c.email === 'payer@example.com').id
    expect(db._state.messages.find(m => m.id === 'm1').contact_id).toBe(linkedId)
    expect(db._state.messages.find(m => m.id === 'm2').contact_id).toBe(linkedId)
    expect(db._state.messages.find(m => m.id === 'm3').contact_id).toBeNull()
    expect(db._state.messages.find(m => m.id === 'm4').contact_id).toBe('someone-else')
  })

  it('calls findOrCreateRaceContact with restrictToOrg: true — the org-scope this route must never widen or drop', async () => {
    await post(T_ACCOUNTS.id)
    expect(findOrCreateRaceContact).toHaveBeenCalledWith(expect.objectContaining({
      locationId: LOC_A,
      email: T_ACCOUNTS.requester_email,
      name: T_ACCOUNTS.requester_name,
      restrictToOrg: true,
    }))
  })

  it('still succeeds (200) when the message backfill itself fails — best-effort, not the primary success', async () => {
    setupDb({ errors: { email_inbox_messages: { code: 'XX000', message: 'messages unwritable' } } })
    const res = await post(T_ACCOUNTS.id)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    // The ticket itself is still linked — only the cosmetic mirror failed.
    expect(updatesTo(db, 'email_tickets')[0].payload.contact_id).toBeTruthy()
  })

  it('500s when the final contact lookup fails AFTER a successful create+link', async () => {
    // The create/insert must succeed (so the ticket really does get linked)
    // and only the RESPONSE-SHAPING lookup that follows must fail — `errors`
    // fails every operation on a table uniformly, so this one case needs a
    // local double: fail `contacts` selects, but only once an insert into it
    // has actually gone through.
    const realFrom = db.from
    let inserted = false
    db.from = (table) => {
      const b = realFrom(table)
      if (table !== 'contacts') return b
      const origInsert = b.insert
      b.insert = (p) => { inserted = true; return origInsert(p) }
      const origMaybeSingle = b.maybeSingle
      b.maybeSingle = () => inserted
        ? Promise.resolve({ data: null, error: { code: 'XX000', message: 'contacts unreadable after insert' } })
        : origMaybeSingle()
      return b
    }

    const res = await post(T_ACCOUNTS.id)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.success).toBe(false)
  })

  it('500s and writes nothing to the ticket when contact resolution itself fails', async () => {
    // Every contacts operation errors, including the create — the ONLY way
    // to make findOrCreateRaceContact itself return null rather than an id
    // (it never throws; a hard failure is reported as null).
    setupDb({ errors: { contacts: { code: 'XX000', message: 'contacts unwritable' } } })
    const res = await post(T_ACCOUNTS.id)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(updatesTo(db, 'email_tickets')).toEqual([])
  })
})

describe('POST …/link-contact — idempotent', () => {
  it('200s with the existing contact when already linked, writing nothing', async () => {
    setupDb({ contacts: [{ id: 'contact-1', location_id: LOC_A, email: 'member@example.com', name: 'Ada Member', first_name: 'Ada', pipeline_stage_slug: 'member' }] })
    // T_STUDIO already carries contact_id: 'contact-1'.
    const res = await post(T_STUDIO.id)
    expect(res.status).toBe(200)
    const body = await res.json()
    // toMatchObject, not toEqual: the in-memory fake does not model
    // PostgREST's column projection (test-db.js's own header says so), so it
    // returns the whole fixture row rather than just CONTACT_COLUMNS. The
    // route's actual .select(CONTACT_COLUMNS) is what the mutation table
    // below pins.
    expect(body.data.contact).toMatchObject({
      id: 'contact-1', name: 'Ada Member', first_name: 'Ada', email: 'member@example.com', pipeline_stage_slug: 'member',
    })
    expect(writesTo(db)).toEqual([])
  })
})

describe('POST …/link-contact — refuses with no requester_email', () => {
  it('400s and writes nothing when the ticket has no requester_email', async () => {
    setupDb({ tickets: [{ ...T_ACCOUNTS, requester_email: null }] })
    const res = await post(T_ACCOUNTS.id)
    expect(res.status).toBe(400)
    expect(writesTo(db)).toEqual([])
  })
})

describe('POST …/link-contact — the write is error-checked', () => {
  it('500s when the ticket update fails, rather than reporting success', async () => {
    failWrites(db, ['email_tickets'])
    const res = await post(T_ACCOUNTS.id)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.success).toBe(false)
  })

  it('500s when the existing-contact lookup fails on the idempotent path', async () => {
    setupDb({ errors: { contacts: { code: 'XX000', message: 'contacts unreadable' } } })
    const res = await post(T_STUDIO.id)
    expect(res.status).toBe(500)
  })
})
