// EMAIL-TICKET.3 — routing + write behaviour of the inbound email webhook
// after the ticket cutover.
//
// THE BUG THIS FILE EXISTS FOR
// The route used to resolve an unmatched recipient to "the oldest active
// location". On 2026-08-05 Postmark's own sample payload
// (mailbox+samplehash@inbound.postmarkapp.com) matched nothing and filed
// itself into Stillorgan's queue. Every fixture below therefore carries a
// SECOND, OLDER mailbox at a DIFFERENT location: if anyone reintroduces an
// oldest-location fallback, the routing tests fail rather than quietly
// misfiling one studio's mail into another's.
//
// The other property under test is the dual-write. Nine files still read
// email_conversations (EmailInbox.jsx, UnifiedInbox.jsx, …), so every inbound
// must produce BOTH a ticket and a conversation until Plan 7's UI lands.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/webhook-dead-letter', () => ({ deadLetterWebhook: vi.fn() }))
vi.mock('@/lib/webhook-events', async () => {
  const actual = await vi.importActual('@/lib/webhook-events')
  return { ...actual, recordWebhookEvent: vi.fn() }
})

import { POST } from './route'
import { createServerClient } from '@/lib/supabase'
import { deadLetterWebhook } from '@/lib/webhook-dead-letter'
import { recordWebhookEvent } from '@/lib/webhook-events'

// ── Fixtures ────────────────────────────────────────────────────────
// STILLORGAN is deliberately FIRST (and older): it is what an oldest-active
// fallback would pick. Nothing routed by these tests belongs to it.
const STILLORGAN = {
  id: 'mb-stillorgan', location_id: 'loc-stillorgan',
  address: 'stillorgan@un1tdublin.com', active: true, created_at: '2026-01-01T00:00:00Z',
}
const HATCH = {
  id: 'mb-hatch', location_id: 'loc-hatch',
  address: 'accounts@hatchstreetfitness.com', active: true, created_at: '2026-08-01T00:00:00Z',
}
const CONTACT = {
  id: 'c-1', location_id: 'loc-hatch',
  email: 'member@example.com', created_at: '2025-01-01T00:00:00Z',
}

function inbound(overrides = {}) {
  return {
    MessageID: 'pm-inbound-1',
    From: 'member@example.com',
    FromFull: { Email: 'member@example.com', Name: 'Ada Member' },
    ToFull: [{ Email: 'accounts@hatchstreetfitness.com' }],
    Subject: 'Billing question',
    TextBody: 'My direct debit bounced.',
    HtmlBody: '<p>My direct debit bounced.</p>',
    Headers: [{ Name: 'Message-ID', Value: '<inbound-1@mail.example.com>' }],
    Date: '2026-08-06T09:00:00Z',
    ...overrides,
  }
}

/** A reply whose In-Reply-To points at one of our earlier messages. */
function reply(overrides = {}) {
  return inbound({
    MessageID: 'pm-inbound-2',
    Subject: 'Re: Billing question',
    Headers: [
      { Name: 'Message-ID', Value: '<inbound-2@mail.example.com>' },
      { Name: 'In-Reply-To', Value: '<ours-1@mtasv.net>' },
    ],
    ...overrides,
  })
}

// ── Fake supabase ───────────────────────────────────────────────────
// Records every write so a test can assert on what the route actually put in
// the database, and honours eq/in/ilike so the route's own filters (notably
// `.eq('active', true)` on email_mailboxes) are genuinely exercised rather
// than being papered over by the pure helper's second check.
function applyFilters(list, filters) {
  return list.filter(row => filters.every(f => {
    if (f[0] === 'eq') return row[f[1]] === f[2]
    if (f[0] === 'in') return f[2].includes(row[f[1]])
    if (f[0] === 'ilike') return String(row[f[1]] ?? '').toLowerCase() === String(f[2]).toLowerCase()
    return true // order/limit/not/or are not modelled
  }))
}

function makeDb(state = {}) {
  const s = {
    mailboxes: [STILLORGAN, HATCH],
    sends: [],
    contacts: [CONTACT],
    threadRows: [],   // email_inbox_messages rows a threading header can match
    tickets: {},      // id → email_tickets row
    conversation: null, // the existing email_conversations row, if any
    ...state,
  }

  const db = { inserts: [], updates: [], rpcs: [], _state: s }

  function rowsFor(b) {
    switch (b._table) {
      case 'email_sends': return applyFilters(s.sends, b._filters)
      case 'email_mailboxes': return applyFilters(s.mailboxes, b._filters)
      case 'contacts': return applyFilters(s.contacts, b._filters)
      case 'email_inbox_messages': return applyFilters(s.threadRows, b._filters)
      case 'email_tickets': return applyFilters(Object.values(s.tickets), b._filters)
      case 'email_conversations': return applyFilters(s.conversation ? [s.conversation] : [], b._filters)
      default: return []
    }
  }

  function settle(b, shape) {
    if (b._op === 'insert') {
      db.inserts.push({ table: b._table, payload: b._payload })
      const id = b._table === 'email_tickets' ? 'new-ticket'
        : b._table === 'email_conversations' ? 'new-conversation'
        : 'new-row'
      return { data: { id }, error: null }
    }
    if (b._op === 'update') {
      db.updates.push({ table: b._table, payload: b._payload, filters: b._filters })
      return { data: null, error: null }
    }
    const list = rowsFor(b)
    return shape === 'list' ? { data: list, error: null } : { data: list[0] ?? null, error: null }
  }

  db.from = (table) => {
    const b = { _table: table, _op: 'select', _payload: null, _filters: [] }
    const filter = (kind) => (...args) => { b._filters.push([kind, ...args]); return b }
    b.select = () => b
    b.insert = (p) => { b._op = 'insert'; b._payload = p; return b }
    b.update = (p) => { b._op = 'update'; b._payload = p; return b }
    b.eq = filter('eq')
    b.is = filter('is')
    b.not = filter('not')
    b.in = filter('in')
    b.ilike = filter('ilike')
    b.or = filter('or')
    b.order = () => b
    b.limit = () => b
    b.single = () => Promise.resolve(settle(b, 'single'))
    b.maybeSingle = () => Promise.resolve(settle(b, 'single'))
    // supabase-js builders are thenables, not Promises — mirror that.
    b.then = (res, rej) => Promise.resolve(settle(b, 'list')).then(res, rej)
    return b
  }
  db.rpc = (fn, args) => {
    db.rpcs.push({ fn, args })
    return Promise.resolve({ data: null, error: null })
  }
  return db
}

const insertsInto = (db, table) => db.inserts.filter(i => i.table === table)
const updatesTo = (db, table) => db.updates.filter(u => u.table === table)

function post(body, token = 'inbound-secret') {
  return POST({ json: async () => body }, { params: Promise.resolve({ token }) })
}

let db
beforeEach(() => {
  vi.clearAllMocks()
  process.env.POSTMARK_EMAIL_INBOX_WEBHOOK_TOKEN = 'inbound-secret'
  recordWebhookEvent.mockResolvedValue({ seen: false })
  db = makeDb()
  createServerClient.mockImplementation(() => db)
})
afterEach(() => {
  delete process.env.POSTMARK_EMAIL_INBOX_WEBHOOK_TOKEN
})

describe('mailbox routing', () => {
  it('dead-letters an unmatched recipient instead of filing it somewhere', async () => {
    // The 2026-08-05 incident payload, verbatim in shape.
    const res = await post(inbound({
      ToFull: [{ Email: 'mailbox+samplehash@inbound.postmarkapp.com' }],
    }))

    expect(res.status).toBe(200) // non-2xx makes Postmark disable the webhook
    expect(await res.json()).toEqual({ success: true, dead_lettered: 'no_matching_mailbox' })
    expect(deadLetterWebhook).toHaveBeenCalledTimes(1)
    expect(deadLetterWebhook.mock.calls[0][1]).toMatchObject({ error: 'no_matching_mailbox' })
    // Nothing was written anywhere — not into the oldest location, not anywhere.
    expect(insertsInto(db, 'email_tickets')).toHaveLength(0)
    expect(insertsInto(db, 'email_conversations')).toHaveLength(0)
    expect(insertsInto(db, 'email_inbox_messages')).toHaveLength(0)
  })

  it('files to the MATCHED mailbox’s location, not the oldest one', async () => {
    const res = await post(inbound())
    expect(res.status).toBe(200)

    const [ticket] = insertsInto(db, 'email_tickets')
    expect(ticket.payload.location_id).toBe('loc-hatch')
    expect(ticket.payload.location_id).not.toBe('loc-stillorgan')
    expect(ticket.payload.mailbox_id).toBe('mb-hatch')
    expect((await res.json()).mailbox_id).toBe('mb-hatch')
  })

  it('dead-letters mail to an INACTIVE mailbox', async () => {
    db = makeDb({ mailboxes: [STILLORGAN, { ...HATCH, active: false }] })
    createServerClient.mockImplementation(() => db)

    const res = await post(inbound())

    expect(res.status).toBe(200)
    expect((await res.json()).dead_lettered).toBe('no_matching_mailbox')
    expect(deadLetterWebhook).toHaveBeenCalledTimes(1)
    expect(insertsInto(db, 'email_tickets')).toHaveLength(0)
  })
})

describe('dual-write', () => {
  it('writes a ticket AND a conversation, and stamps both ids on the message', async () => {
    const res = await post(inbound())
    const json = await res.json()

    expect(insertsInto(db, 'email_tickets')).toHaveLength(1)
    expect(insertsInto(db, 'email_conversations')).toHaveLength(1)

    const [message] = insertsInto(db, 'email_inbox_messages')
    expect(message.payload.ticket_id).toBe('new-ticket')
    expect(message.payload.conversation_id).toBe('new-conversation')
    expect(message.payload.location_id).toBe('loc-hatch')

    expect(json).toMatchObject({
      success: true,
      ticket_id: 'new-ticket',
      conversation_id: 'new-conversation',
      mailbox_id: 'mb-hatch',
    })
  })

  it('opens the ticket with the requester, subject and contact linkage', async () => {
    await post(inbound())
    const [ticket] = insertsInto(db, 'email_tickets')
    expect(ticket.payload).toMatchObject({
      status: 'open',
      requester_email: 'member@example.com',
      requester_name: 'Ada Member',
      subject: 'Billing question',
      contact_id: 'c-1',
      reopened_from: null,
    })
    expect(db.rpcs).toContainEqual({
      fn: 'increment_email_ticket_unread', args: { p_ticket_id: 'new-ticket' },
    })
    // The legacy unread bump still runs — the live inbox reads it.
    expect(db.rpcs).toContainEqual({
      fn: 'increment_email_conversation_unread', args: { p_conversation_id: 'new-conversation' },
    })
  })
})

describe('threading', () => {
  it('appends a reply to the open ticket rather than minting a second', async () => {
    db = makeDb({
      threadRows: [{ ticket_id: 'T-open', created_at: '2026-08-06T08:00:00Z', location_id: 'loc-hatch', rfc_message_id: 'ours-1@mtasv.net' }],
      tickets: { 'T-open': { id: 'T-open', location_id: 'loc-hatch', status: 'open', subject: 'Billing question', first_response_at: null } },
      conversation: { id: 'conv-1', location_id: 'loc-hatch', counterpart_email: 'member@example.com', contact_id: 'c-1' },
    })
    createServerClient.mockImplementation(() => db)

    const res = await post(reply())
    const json = await res.json()

    expect(insertsInto(db, 'email_tickets')).toHaveLength(0)
    expect(json.ticket_id).toBe('T-open')

    const [update] = updatesTo(db, 'email_tickets')
    expect(update.payload.status).toBe('open')
    expect(update.payload.last_message_direction).toBe('inbound')
    // A ticket is named by the issue that opened it — never re-titled "Re: …".
    expect(update.payload).not.toHaveProperty('subject')
    expect(update.filters).toContainEqual(['eq', 'id', 'T-open'])

    expect(insertsInto(db, 'email_inbox_messages')[0].payload.ticket_id).toBe('T-open')
  })

  it('mints a NEW ticket when the reply threads to a CLOSED one', async () => {
    db = makeDb({
      threadRows: [{ ticket_id: 'T-closed', created_at: '2026-07-01T08:00:00Z', location_id: 'loc-hatch', rfc_message_id: 'ours-1@mtasv.net' }],
      tickets: { 'T-closed': { id: 'T-closed', location_id: 'loc-hatch', status: 'closed', subject: 'Billing question', first_response_at: '2026-07-01T09:00:00Z' } },
    })
    createServerClient.mockImplementation(() => db)

    const res = await post(reply())

    const tickets = insertsInto(db, 'email_tickets')
    expect(tickets).toHaveLength(1)
    expect(tickets[0].payload.reopened_from).toBe('T-closed')
    expect(tickets[0].payload.status).toBe('open')
    // The closed predecessor is NOT resurrected.
    expect(updatesTo(db, 'email_tickets')).toHaveLength(0)
    expect((await res.json()).ticket_id).toBe('new-ticket')
  })

  it('picks the most recent thread match when several rows match', async () => {
    db = makeDb({
      threadRows: [
        { ticket_id: 'T-old', created_at: '2026-05-01T08:00:00Z', location_id: 'loc-hatch', rfc_message_id: 'ours-1@mtasv.net' },
        { ticket_id: 'T-live', created_at: '2026-08-06T08:00:00Z', location_id: 'loc-hatch', postmark_message_id: 'ours-1' },
      ],
      tickets: {
        'T-old': { id: 'T-old', location_id: 'loc-hatch', status: 'open', subject: 'Ancient', first_response_at: null },
        'T-live': { id: 'T-live', location_id: 'loc-hatch', status: 'open', subject: 'Current', first_response_at: null },
      },
    })
    createServerClient.mockImplementation(() => db)

    const res = await post(reply())
    expect((await res.json()).ticket_id).toBe('T-live')
  })
})

describe('idempotency', () => {
  it('returns deduped and writes NOTHING for a MessageID already seen', async () => {
    recordWebhookEvent.mockResolvedValue({ seen: true })

    const res = await post(inbound())

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, deduped: true })
    expect(db.inserts).toHaveLength(0)
    expect(db.updates).toHaveLength(0)
    expect(db.rpcs).toHaveLength(0)
    expect(deadLetterWebhook).not.toHaveBeenCalled()
  })
})

describe('preserved gates', () => {
  it('404s a wrong token without touching the database', async () => {
    const res = await post(inbound(), 'not-the-token')
    expect(res.status).toBe(404)
    expect(db.inserts).toHaveLength(0)
  })

  it('400s an unparseable body', async () => {
    const res = await POST(
      { json: async () => { throw new SyntaxError('bad json') } },
      { params: Promise.resolve({ token: 'inbound-secret' }) },
    )
    expect(res.status).toBe(400)
  })

  it('400s a payload with no MessageID', async () => {
    const res = await post(inbound({ MessageID: undefined }))
    expect(res.status).toBe(400)
  })
})
