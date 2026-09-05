// MAIL-ALLLOC.1 — the multi-location digest behind Mail's location tiles.
//
// The design's load-bearing properties, each pinned here:
//   • one request answers every location the caller may read Mail at — the
//     tile row, the All-mode sections, and both counts come off this
//   • sections are CAPPED (newest DIGEST_ROWS_PER_LOCATION per studio) — the
//     digest is a triage surface, the scoped list is the working one
//   • a location whose lookup FAILED is reported unavailable, never silently
//     missing — a digest quietly dropping a studio is the "calm empty inbox"
//     lie at estate scale
//   • per-location access is the SAME model as the scoped list: the
//     email_inbox key resolved AT each location, per-mailbox grants, orphans
//     to elevated callers only.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({
  // Real module, one override: the auth graph exports far more than this
  // route reads, and a factory that under-mocks it fails on whatever the
  // helpers' import graph touches next.
  ...(await importOriginal()),
  getCurrentUser: vi.fn(),
}))

import { GET } from './route'
import { DIGEST_ROWS_PER_LOCATION } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { makeDb, selectsFrom } from '../../tickets/_test-db'
import {
  LOC_A, LOC_B, T_STUDIO, T_ACCOUNTS, T_OTHER_LOCATION,
  COACH, MASTER, MULTI_LOCATION,
  GRANT_STUDIO, GRANT_MULTI_OTHER_LOCATION, GRANT_MULTI_STUDIO,
  mailState,
} from '../_test-fixtures'

/** Names REVERSED from id order, so passing this sort proves the sort. */
const reverseNamed = (user) => ({
  ...user,
  locations: user.locations.map(l => ({
    ...l,
    name: l.id === LOC_A ? 'Zeta Studio' : 'Beta Studio',
  })),
})

async function digest(query = '') {
  const res = await GET(new Request(`http://x/api/email/mail/digest${query}`))
  return { res, body: await res.json() }
}

let db
function setupDb(state) {
  db = makeDb(state)
  createServerClient.mockImplementation(() => db)
  return db
}

// Give the fixture users location names so the name plumbing is provable.
const named = (user) => ({
  ...user,
  locations: user.locations.map(l => ({
    ...l,
    name: l.id === LOC_A ? 'Alpha Studio' : 'Beta Studio',
  })),
})

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(named(MASTER))
  setupDb(mailState())
})

describe('GET /api/email/mail/digest — gates', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await digest()).res.status).toBe(401)
  })

  it('400s on an unknown view', async () => {
    expect((await digest('?view=solved')).res.status).toBe(400)
  })

  it('answers an empty digest — not an error — for a caller with no eligible location', async () => {
    // COACH holds email_inbox at LOC_A but no grant row in this state, so no
    // location yields a visible mailbox. Same posture as the scoped list.
    getCurrentUser.mockResolvedValue(COACH)
    setupDb(mailState({ grants: [] }))
    const { res, body } = await digest()
    expect(res.status).toBe(200)
    expect(body.data.locations).toEqual([])
    expect(body.data.needs_reply_total).toBe(0)
  })
})

describe('GET /api/email/mail/digest — the multi-location shape', () => {
  it('answers every readable location in one request, sorted by name', async () => {
    setupDb(mailState({
      tickets: [
        { ...T_STUDIO, status: 'open', last_message_direction: 'inbound' },
        { ...T_OTHER_LOCATION, status: 'open', last_message_direction: 'inbound' },
      ],
    }))
    const { res, body } = await digest()
    expect(res.status).toBe(200)
    const locs = body.data.locations
    expect(locs.map(l => l.location_id)).toEqual([LOC_A, LOC_B])
    expect(locs.map(l => l.name)).toEqual(['Alpha Studio', 'Beta Studio'])
    expect(locs[0].needs_reply_count).toBe(1)
    expect(body.data.needs_reply_total).toBe(locs[0].needs_reply_count + locs[1].needs_reply_count)
  })

  it('sorts by NAME, not by the id order the locations arrived in', async () => {
    getCurrentUser.mockResolvedValue(reverseNamed(MASTER))
    setupDb(mailState())
    const { body } = await digest()
    expect(body.data.locations.map(l => l.name)).toEqual(['Beta Studio', 'Zeta Studio'])
  })

  it('a location where the caller lacks email_inbox contributes NOTHING — even when a mailbox grant exists there', async () => {
    // The grant layer and the permission layer are separate gates and this
    // pins the permission one alone: MULTI_LOCATION holds a grant on LOC_B's
    // mailbox but their staff role there does not carry email_inbox, so the
    // location must be absent — not unavailable, not empty, absent.
    getCurrentUser.mockResolvedValue(named(MULTI_LOCATION))
    setupDb(mailState({ grants: [GRANT_MULTI_STUDIO, GRANT_MULTI_OTHER_LOCATION] }))
    const { body } = await digest()
    expect(body.data.locations.map(l => l.location_id)).toEqual([LOC_A])
  })

  it('scopes rows AND counts to the mailboxes the caller may see', async () => {
    // COACH is granted studio@ only; a live needs-reply conversation on
    // accounts@ at the same location must be invisible to every number and
    // every row this digest answers with.
    getCurrentUser.mockResolvedValue(COACH)
    setupDb(mailState({
      tickets: [
        { ...T_STUDIO, status: 'open', last_message_direction: 'inbound' },
        { ...T_ACCOUNTS, status: 'open', last_message_direction: 'inbound' },
      ],
      grants: [GRANT_STUDIO],
    }))
    const { body } = await digest()
    const loc = body.data.locations.find(l => l.location_id === LOC_A)
    expect(loc.conversations.map(c => c.id)).toEqual([T_STUDIO.id])
    expect(loc.needs_reply_count).toBe(1)
    expect(loc.view_total).toBe(1)
  })

  it('resolves the permission AT each location — a staff role with no grant contributes nothing', async () => {
    // MULTI_LOCATION is manager at LOC_A (elevated? no — manager is not
    // owner; needs grants) and staff at LOC_B. Grant them studio@ (LOC_A)
    // only: LOC_B must not appear even though they hold a role there.
    getCurrentUser.mockResolvedValue(named(MULTI_LOCATION))
    setupDb(mailState({ grants: [GRANT_MULTI_STUDIO] }))
    const { body } = await digest()
    expect(body.data.locations.map(l => l.location_id)).toEqual([LOC_A])
  })

  it('includes the second location once BOTH its key and its grant exist', async () => {
    // Staff do not hold email_inbox by default — LOC_B needs the per-location
    // permission override AND the mailbox grant. That two-gate shape is the
    // real access model, restated here on purpose.
    const withKeyAtB = {
      ...named(MULTI_LOCATION),
      assignmentsByLocation: {
        ...MULTI_LOCATION.assignmentsByLocation,
        [LOC_B]: { role: 'staff', permissions: { email_inbox: true } },
      },
    }
    getCurrentUser.mockResolvedValue(withKeyAtB)
    setupDb(mailState({ grants: [GRANT_MULTI_STUDIO, GRANT_MULTI_OTHER_LOCATION] }))
    const { body } = await digest()
    expect(body.data.locations.map(l => l.location_id)).toEqual([LOC_A, LOC_B])
  })
})

describe('GET /api/email/mail/digest — the cap', () => {
  it(`caps each section at ${DIGEST_ROWS_PER_LOCATION} newest rows while view_total tells the truth`, async () => {
    const many = Array.from({ length: DIGEST_ROWS_PER_LOCATION + 3 }, (_, i) => ({
      ...T_STUDIO,
      id: `aaaaaaa0-0000-4000-8000-00000000000${i}`,
      status: 'open', last_message_direction: 'inbound',
      last_message_at: `2026-08-2${i}T10:00:00Z`,
    }))
    setupDb(mailState({ tickets: many }))
    const { body } = await digest()
    const locA = body.data.locations.find(l => l.location_id === LOC_A)
    expect(locA.conversations).toHaveLength(DIGEST_ROWS_PER_LOCATION)
    expect(locA.view_total).toBe(DIGEST_ROWS_PER_LOCATION + 3)
    // Newest first — the cap keeps the most recent, drops the oldest.
    const times = locA.conversations.map(c => c.last_message_at)
    expect(times).toEqual([...times].sort().reverse())
  })
})

describe('GET /api/email/mail/digest — views', () => {
  it('view=archived changes the rows and view_total but never the needs-reply tile count', async () => {
    // Deliberately ASYMMETRIC counts (2 live / 1 needs-reply / 1 archived) so
    // a tile count that quietly followed the view could not pass by
    // coincidence — it would read 2 on inbox and 1 on archived.
    setupDb(mailState({
      tickets: [
        { ...T_STUDIO, status: 'open', last_message_direction: 'inbound' },
        { ...T_ACCOUNTS, id: 'cccccccc-0000-4000-8000-000000000003', status: 'pending', last_message_direction: 'outbound' },
        { ...T_ACCOUNTS, status: 'closed' },
      ],
    }))
    const inbox = (await digest()).body.data.locations.find(l => l.location_id === LOC_A)
    const archived = (await digest('?view=archived')).body.data.locations.find(l => l.location_id === LOC_A)
    expect(inbox.view_total).toBe(2)
    expect(archived.view_total).toBe(1)
    expect(archived.conversations.map(c => c.id)).toEqual([T_ACCOUNTS.id])
    expect(inbox.needs_reply_count).toBe(1)
    expect(archived.needs_reply_count).toBe(1)
  })
})

describe('GET /api/email/mail/digest — a failed location is reported, never dropped', () => {
  it('marks the whole digest partial and the location unavailable when its lookup fails', async () => {
    // Failing email_mailboxes fails BOTH locations' visibility lookups in
    // this double (errors are per-table) — the property still proves itself:
    // nothing vanishes, everything failed is SAID to have failed.
    setupDb(mailState({ errors: { email_mailboxes: { code: '08006', message: 'reset' } } }))
    const { res, body } = await digest()
    expect(res.status).toBe(200)
    expect(body.data.partial).toBe(true)
    const locs = body.data.locations
    expect(locs).toHaveLength(2)
    for (const l of locs) {
      expect(l.unavailable).toBe(true)
      expect(l.conversations).toEqual([])
    }
    // An unknown count must not masquerade as zero in the total.
    expect(body.data.needs_reply_total).toBeNull()
  })
})

describe('GET /api/email/mail/digest — row stamps match the scoped list', () => {
  it('stamps needs_reply / archived / unread / has_attachments on digest rows', async () => {
    setupDb(mailState({
      tickets: [{ ...T_STUDIO, status: 'open', last_message_direction: 'inbound' }],
      messages: [{
        id: 'm-1', ticket_id: T_STUDIO.id, location_id: LOC_A,
        direction: 'inbound', seen_at: null,
        email_ticket_attachments: [{ id: 'att-1' }],
      }],
    }))
    const { body } = await digest()
    const row = body.data.locations[0].conversations[0]
    expect(row.needs_reply).toBe(true)
    expect(row.archived).toBe(false)
    expect(row.unread).toBe(true)
    expect(row.has_attachments).toBe(true)
  })
})

// MAIL-PERF.1 — `counts=only`: the location-tile poll asks for tile facts and
// nothing else. The claims: the default answer is untouched (no marker, rows
// present); the counts-only answer keeps the field set but skips the row work
// (one head-count per location, no rows query, no per-row counts pass); an
// unavailable location is still reported and still nulls the total; anything
// other than the one literal is a 400, not a silent full digest.
describe('GET /api/email/mail/digest — counts=only', () => {
  const state = () => mailState({
    tickets: [
      { ...T_STUDIO, status: 'open', last_message_direction: 'inbound' },
      { ...T_OTHER_LOCATION, status: 'open', last_message_direction: 'inbound' },
    ],
    messages: [{
      id: 'm-1', ticket_id: T_STUDIO.id, location_id: LOC_A,
      direction: 'inbound', seen_at: null,
    }],
  })

  it('the default payload carries rows and NO counts_only marker (byte-identical to before)', async () => {
    setupDb(state())
    const { body } = await digest()
    expect(Object.keys(body.data).sort()).toEqual(['locations', 'needs_reply_total', 'partial'])
    expect(body.data.locations[0].conversations).toHaveLength(1)
    expect(body.data.locations[0].view_total).toBe(1)
  })

  it('answers the tile facts with the digest field set, rows empty, view_total null, stamped counts_only', async () => {
    setupDb(state())
    const { res, body } = await digest('?counts=only')
    expect(res.status).toBe(200)
    expect(body.data.counts_only).toBe(true)
    expect(body.data.locations.map(l => l.location_id)).toEqual([LOC_A, LOC_B])
    for (const l of body.data.locations) {
      expect(Object.keys(l).sort()).toEqual(
        ['conversations', 'location_id', 'name', 'needs_reply_count', 'unavailable', 'view_total']
      )
      expect(l.unavailable).toBe(false)
      expect(l.needs_reply_count).toBe(1)
      expect(l.view_total).toBeNull()
      expect(l.conversations).toEqual([])
    }
    expect(body.data.needs_reply_total).toBe(2)
  })

  it('does the count work only — one head-count per location, no rows read, no per-row counts pass', async () => {
    const full = setupDb(state())
    await digest()
    const fullTicketSelects = selectsFrom(full, 'email_tickets')
    const fullMessageSelects = selectsFrom(full, 'email_inbox_messages')

    const lean = setupDb(state())
    await digest('?counts=only')
    const leanTicketSelects = selectsFrom(lean, 'email_tickets')
    // Two locations → exactly two selects, both head-only counts.
    expect(leanTicketSelects).toHaveLength(2)
    expect(leanTicketSelects.every(s => s.options?.head === true)).toBe(true)
    expect(leanTicketSelects.length).toBeLessThan(fullTicketSelects.length)
    // The per-row message-count pass never ran.
    expect(fullMessageSelects.length).toBeGreaterThan(0)
    expect(selectsFrom(lean, 'email_inbox_messages')).toHaveLength(0)
  })

  it('still reports a failed location and nulls the total', async () => {
    setupDb(mailState({ errors: { email_mailboxes: { code: '08006', message: 'reset' } } }))
    const { body } = await digest('?counts=only')
    expect(body.data.partial).toBe(true)
    expect(body.data.locations).toHaveLength(2)
    for (const l of body.data.locations) {
      expect(l.unavailable).toBe(true)
      expect(l.needs_reply_count).toBeNull()
      expect(l.conversations).toEqual([])
    }
    expect(body.data.needs_reply_total).toBeNull()
  })

  it('a counts value other than "only" is a 400, never a silent full digest', async () => {
    setupDb(state())
    expect((await digest('?counts=yes')).res.status).toBe(400)
    expect((await digest('?counts=')).res.status).toBe(400)
  })

  it('composes with view — the view is validated and then irrelevant to the tile facts', async () => {
    setupDb(state())
    expect((await digest('?counts=only&view=solved')).res.status).toBe(400)
    const { body } = await digest('?counts=only&view=archived')
    expect(body.data.counts_only).toBe(true)
    expect(body.data.locations[0].needs_reply_count).toBe(1)
  })
})
