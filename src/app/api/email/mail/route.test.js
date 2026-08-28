// MAIL-TRIAL.B — the Mail list route.
//
// THE TWO PROPERTIES THIS FILE EXISTS FOR
//
// 1. 🔴 A `surface='tickets'` MAILBOX NEVER APPEARS HERE. Every fixture puts
//    accounts@ on the ticket surface at the SAME location as studio@, visible
//    to the elevated caller and granted to nobody in particular — so if the
//    surface filter is ever dropped, an accounts@ conversation shows up on
//    this screen and these tests fail. Without that filter there is no trial:
//    both screens would show everything and Richard would be comparing one
//    surface with itself.
//
// 2. The access model is UNCHANGED. It is the ticket surface's own, imported
//    rather than re-implemented, so the gate tests here are deliberately the
//    same shapes as the ticket route's — a coach without a grant, a location
//    outside the caller's assignments, a failed visibility lookup. If someone
//    "simplifies" _helpers.js into its own copy of the access logic, this
//    block is what catches the divergence.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/permissions', async () => {
  const actual = await vi.importActual('@/lib/permissions')
  return { ...actual, hasPermissionForLocation: vi.fn(() => true) }
})
vi.mock('./_search', () => ({
  searchTicketIds: vi.fn(),
  SEARCH_SCAN_LIMIT: 1000,
}))

import { GET } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { searchTicketIds } from './_search'
import { makeDb } from '../tickets/_test-db'
import {
  LOC_A, LOC_B, MB_MAIL, MB_TICKETS, T_STUDIO, T_ACCOUNTS,
  COACH, OWNER, GRANT_STUDIO, mailState, message,
} from './_test-fixtures'

function req(query = `?location_id=${LOC_A}`) {
  return new Request(`http://x/api/email/mail${query}`)
}

async function list(query) {
  const res = await GET(req(query))
  return { res, body: await res.json() }
}

const ids = (rows) => rows.map(r => r.id)

let db
function setupDb(state) {
  db = makeDb(state)
  createServerClient.mockImplementation(() => db)
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
  hasPermissionForLocation.mockReturnValue(true)
  getCurrentUser.mockResolvedValue(OWNER)
  searchTicketIds.mockResolvedValue({ ok: true, skipped: true, ids: null, partial: false })
  setupDb(mailState())
})

describe('GET /api/email/mail — gates', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await list()).res.status).toBe(401)
  })

  it('403s without the email_inbox permission, resolved at the REQUESTED location', async () => {
    hasPermissionForLocation.mockReturnValue(false)
    expect((await list()).res.status).toBe(403)
    expect(hasPermissionForLocation).toHaveBeenCalledWith(OWNER, LOC_A, 'email_inbox')
  })

  it('400s without a location_id', async () => {
    expect((await list('')).res.status).toBe(400)
  })

  it('403s for a location outside the caller’s assignments', async () => {
    expect((await list(`?location_id=${LOC_B}`)).res.status).toBe(403)
  })

  it('400s on an unknown view rather than silently showing the whole inbox', async () => {
    // A typo'd view that quietly fell back to the default is how an operator
    // ends up believing the archive is empty.
    expect((await list(`?location_id=${LOC_A}&view=closed`)).res.status).toBe(400)
  })
})

// 🔴 The property the whole trial rests on.
describe('GET /api/email/mail — each mailbox belongs to exactly ONE surface', () => {
  it('shows only surface=inbox mailboxes, to an elevated caller who can see both', async () => {
    const { body } = await list()
    expect(body.data.mailboxes.map(m => m.id)).toEqual([MB_MAIL.id])
    // accounts@ is at the SAME location and this caller is an owner — the only
    // thing keeping it off this screen is the surface filter.
    expect(body.data.mailboxes.map(m => m.id)).not.toContain(MB_TICKETS.id)
  })

  it('never lists a conversation that arrived at a surface=tickets mailbox', async () => {
    const { body } = await list()
    expect(ids(body.data.conversations)).toEqual([T_STUDIO.id])
    expect(ids(body.data.conversations)).not.toContain(T_ACCOUNTS.id)
  })

  it('shows nothing at all when every mailbox is on the ticket surface', async () => {
    setupDb(mailState({ mailboxes: [{ ...MB_MAIL, surface: 'tickets' }, MB_TICKETS] }))
    const { res, body } = await list()
    // A studio that has not opted into the trial is a NORMAL state, not an
    // error: mig 575 defaults every existing row to 'tickets'.
    expect(res.status).toBe(200)
    expect(body.data.mailboxes).toEqual([])
    expect(body.data.conversations).toEqual([])
  })

  it('does not treat an UNREADABLE surface value as inbox', async () => {
    // A mailbox row missing from the surface read (a race with a deletion) must
    // not be guessed onto this screen.
    setupDb(mailState({ mailboxes: [{ ...MB_MAIL, surface: null }, MB_TICKETS] }))
    expect((await list()).body.data.mailboxes).toEqual([])
  })

  it('refuses LOUDLY when the surface lookup fails, rather than showing an empty inbox', async () => {
    // Same reasoning as EMAIL-TICKET-CLEANUP.2 next door: an operator reads an
    // empty inbox as "no mail" and stops looking. The two outcomes have to look
    // different to the person reading them.
    setupDb(mailState({ errors: { email_mailboxes: { code: '42703', message: 'column "surface" does not exist' } } }))
    const { res, body } = await list()
    expect(res.status).toBe(500)
    expect(body.success).toBe(false)
    expect(body.data).toBeUndefined()
  })

  it('a NULL-mailbox conversation is not on this surface, even for an owner', async () => {
    // mailbox_id is ON DELETE SET NULL, so orphaned correspondence exists. The
    // ticket queue still shows it to elevated callers — which is what keeps it
    // reachable — and it must therefore NOT also appear here, or one
    // conversation would sit on both screens.
    setupDb(mailState({
      tickets: [{ ...T_STUDIO }, { ...T_ACCOUNTS, id: 'orphan-1', mailbox_id: null }],
    }))
    expect(ids((await list()).body.data.conversations)).toEqual([T_STUDIO.id])
  })
})

describe('GET /api/email/mail — per-account access still applies', () => {
  it('a coach with no grants gets an empty screen, not an error', async () => {
    getCurrentUser.mockResolvedValue(COACH)
    setupDb(mailState({ grants: [] }))
    const { res, body } = await list()
    expect(res.status).toBe(200)
    expect(body.data.mailboxes).toEqual([])
    expect(body.data.conversations).toEqual([])
  })

  it('a coach granted the mail mailbox sees its conversations', async () => {
    getCurrentUser.mockResolvedValue(COACH)
    setupDb(mailState({ grants: [GRANT_STUDIO] }))
    const { body } = await list()
    expect(ids(body.data.conversations)).toEqual([T_STUDIO.id])
  })

  it('filtering to a mailbox that is not on this surface returns nothing, not an error', async () => {
    const { res, body } = await list(`?location_id=${LOC_A}&mailbox_id=${MB_TICKETS.id}`)
    expect(res.status).toBe(200)
    expect(body.data.conversations).toEqual([])
    expect(body.data.mailboxes.map(m => m.id)).toEqual([MB_MAIL.id])
  })
})

describe('GET /api/email/mail — views', () => {
  const world = (tickets) => setupDb(mailState({
    // Everything on the ONE mail mailbox, so the view is the only thing under
    // test here rather than the surface filter.
    tickets: tickets.map(t => ({ ...t, mailbox_id: MB_MAIL.id })),
  }))

  it('the inbox is everything that is not archived — including legacy `solved`', async () => {
    world([
      { ...T_STUDIO, id: 'open-1', status: 'open', last_message_at: '2026-08-01T00:00:00Z' },
      { ...T_STUDIO, id: 'pending-1', status: 'pending', last_message_at: '2026-08-02T00:00:00Z' },
      // This surface never writes `solved`, but old rows carry it. It is not
      // archived, so it is in the inbox — a decision, not a fall-through.
      { ...T_STUDIO, id: 'solved-1', status: 'solved', last_message_at: '2026-08-03T00:00:00Z' },
      { ...T_STUDIO, id: 'closed-1', status: 'closed', last_message_at: '2026-08-04T00:00:00Z' },
    ])
    const { body } = await list()
    expect(ids(body.data.conversations)).toEqual(['solved-1', 'pending-1', 'open-1'])
  })

  it('archived is exactly status=closed', async () => {
    world([
      { ...T_STUDIO, id: 'closed-1', status: 'closed' },
      { ...T_STUDIO, id: 'open-1', status: 'open' },
      { ...T_STUDIO, id: 'solved-1', status: 'solved' },
    ])
    const { body } = await list(`?location_id=${LOC_A}&view=archived`)
    expect(ids(body.data.conversations)).toEqual(['closed-1'])
  })

  // 🔴 The one thing a mail client cannot tell you, kept from the ticket model.
  it('needs_reply is open AND the last word was theirs', async () => {
    world([
      { ...T_STUDIO, id: 'waiting-1', status: 'open', last_message_direction: 'inbound' },
      { ...T_STUDIO, id: 'answered-1', status: 'open', last_message_direction: 'outbound' },
      { ...T_STUDIO, id: 'pending-1', status: 'pending', last_message_direction: 'inbound' },
    ])
    const { body } = await list(`?location_id=${LOC_A}&view=needs_reply`)
    expect(ids(body.data.conversations)).toEqual(['waiting-1'])
  })

  it('stamps needs_reply and archived on every row, so no client re-derives them', async () => {
    world([
      { ...T_STUDIO, id: 'waiting-1', status: 'open', last_message_direction: 'inbound', last_message_at: '2026-08-02T00:00:00Z' },
      { ...T_STUDIO, id: 'closed-1', status: 'closed', last_message_direction: 'outbound', last_message_at: '2026-08-01T00:00:00Z' },
    ])
    const { body } = await list()
    const byId = new Map(body.data.conversations.map(c => [c.id, c]))
    expect(byId.get('waiting-1').needs_reply).toBe(true)
    expect(byId.get('waiting-1').archived).toBe(false)
    expect(byId.get('closed-1')).toBeUndefined() // archived, so not in the inbox
  })

  it('counts the needs-reply badge from the same scope as the list', async () => {
    world([
      { ...T_STUDIO, id: 'waiting-1', status: 'open', last_message_direction: 'inbound' },
      { ...T_STUDIO, id: 'waiting-2', status: 'open', last_message_direction: 'inbound' },
      { ...T_STUDIO, id: 'answered-1', status: 'open', last_message_direction: 'outbound' },
    ])
    expect((await list()).body.data.needs_reply_count).toBe(2)
  })

  it('a merged conversation is a tombstone on this surface too', async () => {
    world([
      { ...T_STUDIO, id: 'survivor', status: 'open' },
      { ...T_STUDIO, id: 'tombstone', status: 'open', merged_into_id: 'survivor' },
    ])
    expect(ids((await list()).body.data.conversations)).toEqual(['survivor'])
  })
})

describe('GET /api/email/mail — read state and conversation counts', () => {
  const oneMailbox = (over = {}) => setupDb(mailState({
    tickets: [{ ...T_STUDIO }],
    ...over,
  }))

  it('an inbound message with no seen_at makes the conversation unread', async () => {
    oneMailbox({ messages: [message({ seen_at: null })] })
    const [row] = (await list()).body.data.conversations
    expect(row.unread).toBe(true)
    expect(row.unread_count_messages).toBe(1)
  })

  it('a seen inbound message does not', async () => {
    oneMailbox({ messages: [message({ seen_at: '2026-08-06T09:30:00Z' })] })
    expect((await list()).body.data.conversations[0].unread).toBe(false)
  })

  it('an unsent OUTBOUND message is never unread, whatever seen_at says', async () => {
    // Our own replies are not something to read. Counting them would make
    // "unread" mean "recent".
    oneMailbox({ messages: [message({ direction: 'outbound', seen_at: null })] })
    const [row] = (await list()).body.data.conversations
    expect(row.unread).toBe(false)
    expect(row.message_count).toBe(1)
  })

  it('counts every message on the conversation, both directions', async () => {
    oneMailbox({
      messages: [
        message({ id: 'm1', seen_at: '2026-08-06T09:30:00Z' }),
        message({ id: 'm2', direction: 'outbound', seen_at: null }),
        message({ id: 'm3', seen_at: null }),
      ],
    })
    const [row] = (await list()).body.data.conversations
    expect(row.message_count).toBe(3)
    expect(row.unread_count_messages).toBe(1)
    expect(row.unread).toBe(true)
  })

  it('says so when the message scan fails, rather than rendering everything as read', async () => {
    oneMailbox({ errors: { email_inbox_messages: { code: '42703', message: 'column "seen_at" does not exist' } } })
    const { res, body } = await list()
    // The correspondence is still perfectly listable without read state, so the
    // list loads — but it must not claim a conversation is read.
    expect(res.status).toBe(200)
    expect(body.data.counts_unavailable).toBe(true)
    expect(body.data.conversations[0].unread).toBe(false)
    expect(body.data.conversations[0].message_count).toBeNull()
  })
})

describe('GET /api/email/mail — paging', () => {
  // Ten conversations at one minute apart, newest last in this array.
  const many = Array.from({ length: 10 }, (_, i) => ({
    ...T_STUDIO,
    id: `conv-${String(i).padStart(2, '0')}`,
    last_message_at: `2026-08-06T09:${String(i).padStart(2, '0')}:00Z`,
  }))

  it('hands back a cursor only when there is another page', async () => {
    setupDb(mailState({ tickets: many }))
    // Ten rows is well under one page, so there is nothing older to fetch and
    // the cursor must be null rather than a timestamp that returns nothing.
    expect((await list()).body.data.next_before).toBeNull()
  })

  it('`before` returns the cursor row and everything older — INCLUSIVE, on purpose', async () => {
    setupDb(mailState({ tickets: many }))
    const { body } = await list(`?location_id=${LOC_A}&before=2026-08-06T09:03:00Z`)
    // conv-03 IS the cursor row and comes back again. The client drops it when
    // it appends (see loadMore's de-dupe by id); the server pays that one
    // duplicate to guarantee the tie case below.
    expect(ids(body.data.conversations)).toEqual(['conv-03', 'conv-02', 'conv-01', 'conv-00'])
  })

  // 🔴 THE REASON IT IS INCLUSIVE. last_message_at is neither unique nor NOT
  // NULL — a bulk backfill hands many rows one timestamp — so when a page
  // boundary fell between two conversations sharing one, a strict `lt` dropped
  // BOTH and the second was unreachable for ever. On a surface whose whole job
  // is that no mail goes missing, that is the worst possible bug to have.
  it('does NOT skip a conversation that shares the cursor timestamp', async () => {
    const tied = '2026-08-06T09:05:00Z'
    setupDb(mailState({
      tickets: [
        { ...T_STUDIO, id: 'conv-tie-a', last_message_at: tied },
        { ...T_STUDIO, id: 'conv-tie-b', last_message_at: tied },
        { ...T_STUDIO, id: 'conv-older', last_message_at: '2026-08-06T09:01:00Z' },
      ],
    }))

    const { body } = await list(`?location_id=${LOC_A}&before=${tied}`)
    const got = ids(body.data.conversations)

    // Both halves of the tie survive the page boundary.
    expect(got).toContain('conv-tie-a')
    expect(got).toContain('conv-tie-b')
    expect(got).toContain('conv-older')
  })
})

// MAIL-SEARCH.3 — search narrows, it NEVER widens.
describe('GET /api/email/mail — search', () => {
  it('🔴 cannot reach a conversation on a mailbox the caller may not see', async () => {
    // T_ACCOUNTS lives on the TICKET surface, so the mail surface must not list
    // it — with or without a query. If search bypassed the scope query this
    // would return it, which is the whole reason the ids are intersected rather
    // than trusted.
    setupDb(mailState({ tickets: [{ ...T_STUDIO }, { ...T_ACCOUNTS }] }))
    searchTicketIds.mockResolvedValue({
      ok: true, skipped: false, partial: false,
      ids: [T_STUDIO.id, T_ACCOUNTS.id],
    })

    const { body } = await list(`?location_id=${LOC_A}&q=freeze`)

    expect(ids(body.data.conversations)).toEqual([T_STUDIO.id])
  })

  it('searches across views — an archived conversation is still findable', async () => {
    setupDb(mailState({ tickets: [{ ...T_STUDIO, status: 'closed' }] }))
    searchTicketIds.mockResolvedValue({ ok: true, skipped: false, partial: false, ids: [T_STUDIO.id] })

    // The inbox view would normally exclude a closed conversation.
    const { body } = await list(`?location_id=${LOC_A}&view=inbox&q=freeze`)

    expect(ids(body.data.conversations)).toEqual([T_STUDIO.id])
  })

  it('answers an empty page when nothing matched, without running an unfiltered query', async () => {
    setupDb(mailState({ tickets: [{ ...T_STUDIO }] }))
    searchTicketIds.mockResolvedValue({ ok: true, skipped: false, partial: false, ids: [] })

    const { body } = await list(`?location_id=${LOC_A}&q=zzzz`)

    expect(body.success).toBe(true)
    expect(body.data.conversations).toEqual([])
  })

  it('surfaces a FAILED search as an error, never as no results', async () => {
    setupDb(mailState({ tickets: [{ ...T_STUDIO }] }))
    searchTicketIds.mockResolvedValue({ ok: false, error: 'boom' })

    const { res, body } = await list(`?location_id=${LOC_A}&q=freeze`)

    expect(res.status).toBe(500)
    expect(body.success).toBe(false)
  })

  it('passes search_partial through so the list can say the scan was truncated', async () => {
    setupDb(mailState({ tickets: [{ ...T_STUDIO }] }))
    searchTicketIds.mockResolvedValue({ ok: true, skipped: false, partial: true, ids: [T_STUDIO.id] })

    const { body } = await list(`?location_id=${LOC_A}&q=the`)

    expect(body.data.search_partial).toBe(true)
  })

  it('does not search at all when no query was given', async () => {
    setupDb(mailState({ tickets: [{ ...T_STUDIO }] }))
    await list(`?location_id=${LOC_A}`)
    expect(searchTicketIds).not.toHaveBeenCalled()
  })
})
