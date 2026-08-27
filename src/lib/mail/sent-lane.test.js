// MAILBOX-SENT.1 — the Sent-folder writer.
//
// THE PROPERTIES THIS FILE EXISTS FOR
//
// 1. IT FINDS THE RIGHT THREAD, BY EITHER HEADER. A reply sent from Gmail
//    carries In-Reply-To and References, and both must land on the ticket the
//    member's mail opened — otherwise the whole phase does nothing.
//
// 2. IT NEVER FILES THE SAME REPLY TWICE, AND IT NEVER FILES OUR OWN. Both are
//    one mechanism — mig 574's UNIQUE (ticket_id, rfc_message_id) — so the fake
//    db below ENFORCES that index. A permissive fake would let a second copy
//    through and every dedupe assertion here would pass with the design
//    deleted.
//
// 3. IT NEVER INVENTS A TICKET. A Sent message with no thread is somebody
//    else's conversation; conjuring a ticket for it is noise an operator has to
//    clear. `db.inserts` staying free of an email_tickets row is the contract.
//
// 4. IT ANSWERS THE MEMBER WITHOUT SHOUTING AT STAFF. needs-reply clears,
//    status does not move, unread_count does not move, and the inbound push
//    module is never even imported — asserted by mocking it to a throwing
//    module, so a future import fails this suite rather than paging a studio.
//
// 5. IT NEVER THROWS. Every DB fault is a returned verdict, because the caller
//    decides whether its cursor may advance and an exception takes that
//    decision away from it.

import { describe, it, expect, beforeEach, vi } from 'vitest'

// 🔴 PROPERTY 4, ENFORCED AT THE MODULE BOUNDARY. If sent-lane.js ever grows an
// import of the inbound push, this factory runs and every test in the file
// fails on the import itself. Nothing to remember, nothing to assert per-test.
vi.mock('../email-inbound-push', () => {
  throw new Error('sent-lane must NEVER import the inbound push (MAILBOX-SENT.1 behaviour 6)')
})

import { fileClientSentReply, MAIL_CLIENT_SOURCE } from './sent-lane'

const LOC = 'a0000000-0000-4000-8000-000000000001'
const OTHER_LOC = 'a0000000-0000-4000-8000-000000000002'
const MAILBOX = {
  id: 'b0000000-0000-4000-8000-000000000001',
  location_id: LOC,
  address: 'hatchstreet@un1t.com',
}
const TICKET = 't0000000-0000-4000-8000-000000000001'

// The member's opening email, already ingested by the inbox lane. Its own RFC
// Message-ID is what a reply's In-Reply-To names.
const INBOUND_RFC = 'member-opening-1@mail.example'

/* ────────────────────────── the fake database ────────────────────────── */
//
// Deliberately local rather than the shared ticket-route fake: mig 574's index
// is the entire subject of this file, and the shared fake's UNIQUE_KEYS map
// (which this phase does not own) knows nothing about it. It is modelled here,
// scoped to (ticket_id, rfc_message_id) and partial on rfc_message_id — the
// same shape the migration creates. A global unique on rfc_message_id would
// pass most of these tests, which is exactly why the scope is asserted
// directly further down.

function makeDb({ messages = [], tickets = [], errors = {} } = {}) {
  const state = { email_inbox_messages: messages, email_tickets: tickets }
  const db = { inserts: [], updates: [], selects: [], _state: state }
  let seq = 0

  const matches = (row, [kind, col, a, b]) => {
    const value = row[col] ?? null
    switch (kind) {
      case 'eq': return value === a
      case 'in': return Array.isArray(a) && a.includes(value)
      case 'not': return a === 'is' && b === null ? value !== null : true
      default: return true
    }
  }

  function settle(builder, shape) {
    const { _table: table, _op: op, _filters: filters, _payload: payload } = builder
    const injected = errors[`${table}.${op}`] ?? errors[table]
    if (injected) return { data: null, error: injected }
    const rows = state[table] || []

    if (op === 'insert') {
      db.inserts.push({ table, payload })
      // Mig 574, modelled: UNIQUE (ticket_id, rfc_message_id) WHERE
      // rfc_message_id IS NOT NULL. Partial, so a null id never collides.
      if (table === 'email_inbox_messages' && payload.rfc_message_id != null) {
        const clash = rows.some(r => r.ticket_id === payload.ticket_id
          && r.rfc_message_id === payload.rfc_message_id)
        if (clash) {
          return {
            data: null,
            error: {
              code: '23505',
              message: 'duplicate key value violates unique constraint "email_inbox_messages_ticket_rfc_uidx"',
            },
          }
        }
      }
      const row = { id: `new-${table}-${++seq}`, created_at: `2026-08-26T09:00:0${seq}Z`, ...payload }
      rows.push(row)
      return { data: row, error: null }
    }

    if (op === 'update') {
      db.updates.push({ table, payload, filters })
      const hit = rows.filter(r => filters.every(f => matches(r, f)))
      for (const r of hit) Object.assign(r, payload)
      return { data: hit, error: null }
    }

    db.selects.push({ table, columns: builder._select })
    const hit = rows.filter(r => filters.every(f => matches(r, f)))
    return shape === 'single'
      ? { data: hit[0] ?? null, error: null }
      : { data: hit, error: null }
  }

  db.from = (table) => {
    const b = { _table: table, _op: 'select', _payload: null, _filters: [], _select: '*' }
    const filter = (kind) => (...args) => { b._filters.push([kind, ...args]); return b }
    b.select = (columns) => { b._select = columns ?? '*'; return b }
    b.insert = (p) => { b._op = 'insert'; b._payload = p; return b }
    b.update = (p) => { b._op = 'update'; b._payload = p; return b }
    b.eq = filter('eq')
    b.in = filter('in')
    b.not = filter('not')
    b.single = () => Promise.resolve(settle(b, 'single'))
    b.maybeSingle = () => Promise.resolve(settle(b, 'single'))
    // supabase-js builders are thenables, not Promises — mirror that exactly.
    b.then = (res, rej) => Promise.resolve(settle(b, 'list')).then(res, rej)
    return b
  }

  // Present so a stray rpc is RECORDED rather than crashing — which is how
  // "unread_count is never incremented" is proven below.
  db.rpcs = []
  db.rpc = (fn, args) => { db.rpcs.push({ fn, args }); return Promise.resolve({ data: null, error: null }) }

  return db
}

/* ───────────────────────────── fixtures ──────────────────────────────── */

const ticketRow = (over = {}) => ({
  id: TICKET,
  location_id: LOC,
  contact_id: 'c0000000-0000-4000-8000-000000000001',
  status: 'open',
  last_message_at: '2026-08-26T08:00:00.000Z',
  last_message_direction: 'inbound',
  last_message_preview: 'Can I move my Thursday class?',
  first_response_at: null,
  unread_count: 2,
  ...over,
})

/** The member's opening message row, as the inbox lane filed it. */
const inboundRow = (over = {}) => ({
  id: 'm-inbound-1',
  ticket_id: TICKET,
  location_id: LOC,
  direction: 'inbound',
  rfc_message_id: INBOUND_RFC,
  postmark_message_id: 'imap-a0000000-deadbeef',
  created_at: '2026-08-26T08:00:00.000Z',
  ...over,
})

/**
 * A Postmark-shaped payload of the kind toInboundPayload() produces, for a
 * reply someone sent from their mail client.
 */
const sentPayload = ({
  messageId = 'gmail-reply-1@mail.gmail.com',
  inReplyTo = `<${INBOUND_RFC}>`,
  references = null,
  date = '2026-08-26T09:00:00.000Z',
  subject = 'Re: Can I move my Thursday class?',
  text = 'No problem — I have moved you to Friday 6pm.',
  html = null,
} = {}) => {
  const Headers = []
  if (messageId) Headers.push({ Name: 'Message-ID', Value: `<${messageId}>` })
  if (inReplyTo) Headers.push({ Name: 'In-Reply-To', Value: inReplyTo })
  if (references) Headers.push({ Name: 'References', Value: references })
  return {
    MessageID: 'imap-a0000000-cafebabe',
    From: 'UN1T Hatch Street <hatchstreet@un1t.com>',
    FromFull: { Email: 'hatchstreet@un1t.com', Name: 'UN1T Hatch Street' },
    To: 'Ada Member <ada@example.com>',
    ToFull: [{ Email: 'ada@example.com', Name: 'Ada Member' }],
    CcFull: [],
    Subject: subject,
    TextBody: text,
    HtmlBody: html,
    Date: date,
    OriginalRecipient: 'hatchstreet@un1t.com',
    Headers,
    Attachments: [],
  }
}

const file = (db, over = {}) => fileClientSentReply(db, {
  mailbox: MAILBOX,
  msg: { uid: 77 },
  payload: sentPayload(),
  ...over,
})

const messageInserts = (db) => db.inserts.filter(i => i.table === 'email_inbox_messages')
const ticketInserts = (db) => db.inserts.filter(i => i.table === 'email_tickets')
const ticketUpdates = (db) => db.updates.filter(u => u.table === 'email_tickets')

let warn
let error
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  error = vi.spyOn(console, 'error').mockImplementation(() => {})
})

/* ─────────────────────────────── tests ───────────────────────────────── */

describe('fileClientSentReply — threading', () => {
  it('threads onto the ticket named by In-Reply-To', async () => {
    const db = makeDb({ messages: [inboundRow()], tickets: [ticketRow()] })

    const res = await file(db)

    expect(res).toMatchObject({ ok: true, outcome: 'filed', ticketId: TICKET })
    expect(messageInserts(db)).toHaveLength(1)
    expect(messageInserts(db)[0].payload.ticket_id).toBe(TICKET)
  })

  it('threads onto the ticket named by References when there is no In-Reply-To', async () => {
    const db = makeDb({ messages: [inboundRow()], tickets: [ticketRow()] })

    const res = await file(db, {
      payload: sentPayload({
        inReplyTo: null,
        references: `<something-older@x.test> <${INBOUND_RFC}>`,
      }),
    })

    expect(res).toMatchObject({ ok: true, outcome: 'filed', ticketId: TICKET })
    expect(messageInserts(db)[0].payload.ticket_id).toBe(TICKET)
  })

  it('threads on postmark_message_id too — a reply to one of our Postmark-era sends', async () => {
    const db = makeDb({
      messages: [inboundRow({ rfc_message_id: null, postmark_message_id: 'pm-uuid-1' })],
      tickets: [ticketRow()],
    })

    const res = await file(db, { payload: sentPayload({ inReplyTo: '<pm-uuid-1>' }) })

    expect(res).toMatchObject({ ok: true, outcome: 'filed', ticketId: TICKET })
  })

  it('is scoped to the mailbox location — a thread at another studio is not ours', async () => {
    const db = makeDb({
      messages: [inboundRow({ location_id: OTHER_LOC })],
      tickets: [ticketRow({ location_id: OTHER_LOC })],
    })

    const res = await file(db)

    expect(res).toEqual({ ok: true, outcome: 'orphan' })
    expect(messageInserts(db)).toHaveLength(0)
  })

  it('uses two .in() filters rather than an .or() string', async () => {
    // .or() takes a RAW PostgREST filter, so a stray ')' in a References header
    // would rewrite it. The fake has no .or() at all, so a regression here is a
    // TypeError rather than a silent filter rewrite — this asserts the shape
    // that keeps it that way.
    const db = makeDb({ messages: [inboundRow()], tickets: [ticketRow()] })

    await file(db, {
      payload: sentPayload({ inReplyTo: `<${INBOUND_RFC}> weird) chars ,and,commas` }),
    })

    const reads = db.selects.filter(s => s.table === 'email_inbox_messages')
    expect(reads).toHaveLength(2)
  })
})

describe('fileClientSentReply — the row it writes', () => {
  it('writes an outbound mail_client row with no author and no postmark id', async () => {
    const db = makeDb({ messages: [inboundRow()], tickets: [ticketRow()] })

    await file(db)

    expect(messageInserts(db)[0].payload).toMatchObject({
      ticket_id: TICKET,
      location_id: LOC,
      direction: 'outbound',
      is_internal_note: false,
      source: 'mail_client',
      author_profile_id: null,
      postmark_message_id: null,
      from_email: 'hatchstreet@un1t.com',
      status: 'sent',
    })
    expect(MAIL_CLIENT_SOURCE).toBe('mail_client')
  })

  it('🔴 stores rfc_message_id BARE — no angle brackets', async () => {
    // The whole threading chain is plain string equality, and mig 574's index
    // is built on this column. A bracketed value matches nothing, so the index
    // would silently protect nothing. This exact bug shipped once in the send
    // path.
    const db = makeDb({ messages: [inboundRow()], tickets: [ticketRow()] })

    await file(db, { payload: sentPayload({ messageId: 'reply-abc@mail.gmail.com' }) })

    const { rfc_message_id: stored } = messageInserts(db)[0].payload
    expect(stored).toBe('reply-abc@mail.gmail.com')
    expect(stored).not.toMatch(/[<>]/)
  })

  it('carries the body, subject, recipients and threading headers through', async () => {
    const db = makeDb({ messages: [inboundRow()], tickets: [ticketRow()] })

    await file(db, {
      payload: sentPayload({ references: `<${INBOUND_RFC}>`, text: 'Moved you to Friday.' }),
    })

    expect(messageInserts(db)[0].payload).toMatchObject({
      subject: 'Re: Can I move my Thursday class?',
      text_body: 'Moved you to Friday.',
      to_email: 'ada@example.com',
      to_emails: ['ada@example.com'],
      cc_emails: [],
      in_reply_to: `<${INBOUND_RFC}>`,
      references_header: `<${INBOUND_RFC}>`,
      contact_id: 'c0000000-0000-4000-8000-000000000001',
    })
  })

  it('files an HTML-only reply with plain text derived from the markup', async () => {
    const db = makeDb({ messages: [inboundRow()], tickets: [ticketRow()] })

    await file(db, { payload: sentPayload({ text: '', html: '<p>Moved you to Friday.</p>' }) })

    const row = messageInserts(db)[0].payload
    expect(row.text_body).toContain('Moved you to Friday.')
    expect(row.html_body).toBe('<p>Moved you to Friday.</p>')
  })

  it('files a message with no Message-ID rather than dropping the answer', async () => {
    const db = makeDb({ messages: [inboundRow()], tickets: [ticketRow()] })

    const res = await file(db, { payload: sentPayload({ messageId: null }) })

    expect(res).toMatchObject({ ok: true, outcome: 'filed' })
    expect(messageInserts(db)[0].payload.rfc_message_id).toBeNull()
    expect(warn).toHaveBeenCalled()
  })
})

describe('fileClientSentReply — dedupe (mig 574)', () => {
  it('🔴 skips OUR OWN SMTP send: the reply route already wrote that rfc id on that ticket', async () => {
    // No "is this ours?" comparison exists anywhere in the lane. The send path
    // wrote the row; the Sent copy simply collides.
    const ourSend = {
      id: 'm-our-send',
      ticket_id: TICKET,
      location_id: LOC,
      direction: 'outbound',
      source: 'operator',
      rfc_message_id: 'crm-send-1@un1t.com',
      created_at: '2026-08-26T08:59:00.000Z',
    }
    const db = makeDb({
      messages: [inboundRow(), ourSend],
      // The reply route already advanced this ticket at send time.
      tickets: [ticketRow({
        status: 'pending',
        last_message_at: '2026-08-26T08:59:00.000Z',
        last_message_direction: 'outbound',
        first_response_at: '2026-08-26T08:59:00.000Z',
      })],
    })

    const res = await file(db, {
      payload: sentPayload({ messageId: 'crm-send-1@un1t.com', date: '2026-08-26T08:59:00.000Z' }),
    })

    expect(res).toEqual({ ok: true, outcome: 'duplicate', ticketId: TICKET })
    // One insert ATTEMPTED, none accepted — the state still holds the single row.
    expect(db._state.email_inbox_messages.filter(m => m.rfc_message_id === 'crm-send-1@un1t.com'))
      .toHaveLength(1)
    // And the ticket the reply route already bumped is left exactly alone.
    expect(ticketUpdates(db)).toHaveLength(0)
  })

  it('🔴 dedupes a re-poll of the same message', async () => {
    const db = makeDb({ messages: [inboundRow()], tickets: [ticketRow()] })

    const first = await file(db)
    const second = await file(db)

    expect(first).toMatchObject({ ok: true, outcome: 'filed' })
    expect(second).toEqual({ ok: true, outcome: 'duplicate', ticketId: TICKET })
    expect(db._state.email_inbox_messages.filter(m => m.source === 'mail_client')).toHaveLength(1)
  })

  it('🔴 the index is PER TICKET, not global — a second mailbox on the same thread still files', async () => {
    // The connector deliberately files one copy per connected mailbox. A global
    // unique on rfc_message_id would refuse this insert, silently, and the
    // second studio's copy of the reply would never appear on its own ticket.
    const OTHER_TICKET = 't0000000-0000-4000-8000-000000000002'
    const db = makeDb({
      messages: [
        inboundRow(),
        inboundRow({ id: 'm-inbound-2', ticket_id: OTHER_TICKET, rfc_message_id: 'member-opening-2@mail.example' }),
        // The same reply, already filed on the FIRST ticket.
        {
          id: 'm-sent-1',
          ticket_id: TICKET,
          location_id: LOC,
          direction: 'outbound',
          source: 'mail_client',
          rfc_message_id: 'shared-reply@mail.gmail.com',
          created_at: '2026-08-26T09:00:00.000Z',
        },
      ],
      tickets: [ticketRow(), ticketRow({ id: OTHER_TICKET })],
    })

    const res = await file(db, {
      payload: sentPayload({
        messageId: 'shared-reply@mail.gmail.com',
        inReplyTo: '<member-opening-2@mail.example>',
      }),
    })

    expect(res).toMatchObject({ ok: true, outcome: 'filed', ticketId: OTHER_TICKET })
    expect(db._state.email_inbox_messages
      .filter(m => m.rfc_message_id === 'shared-reply@mail.gmail.com')).toHaveLength(2)
  })

  it('finishes the ticket bump a crashed earlier attempt never reached', async () => {
    // The insert landed, the bump did not (a transient DB fault → ok:false →
    // the poller held its cursor). The retry must not answer a bare
    // `duplicate`, or the ticket keeps saying "needs reply" with the answer
    // sitting inside it — this phase's own bug, reintroduced by its error path.
    const db = makeDb({
      messages: [
        inboundRow(),
        {
          id: 'm-sent-orphaned-bump',
          ticket_id: TICKET,
          location_id: LOC,
          direction: 'outbound',
          source: 'mail_client',
          rfc_message_id: 'gmail-reply-1@mail.gmail.com',
          created_at: '2026-08-26T09:00:00.000Z',
        },
      ],
      tickets: [ticketRow()],
    })

    const res = await file(db)

    expect(res).toEqual({ ok: true, outcome: 'duplicate', ticketId: TICKET })
    expect(ticketUpdates(db)).toHaveLength(1)
    expect(ticketUpdates(db)[0].payload).toMatchObject({ last_message_direction: 'outbound' })
  })
})

describe('fileClientSentReply — the orphan rule', () => {
  it('🔴 no thread ⇒ orphan, and NO ticket is created', async () => {
    const db = makeDb({ messages: [inboundRow()], tickets: [ticketRow()] })

    const res = await file(db, { payload: sentPayload({ inReplyTo: '<never-seen@elsewhere.test>' }) })

    expect(res).toEqual({ ok: true, outcome: 'orphan' })
    expect(ticketInserts(db)).toHaveLength(0)
    expect(messageInserts(db)).toHaveLength(0)
    expect(db.inserts).toHaveLength(0)
    expect(warn).toHaveBeenCalled()
  })

  it('a message with no threading headers at all is an orphan, not a new ticket', async () => {
    const db = makeDb({ messages: [inboundRow()], tickets: [ticketRow()] })

    const res = await file(db, { payload: sentPayload({ inReplyTo: null, references: null }) })

    expect(res).toEqual({ ok: true, outcome: 'orphan' })
    expect(db.inserts).toHaveLength(0)
  })

  it('a thread pointing at a ticket that no longer exists is an orphan', async () => {
    const db = makeDb({ messages: [inboundRow()], tickets: [] })

    const res = await file(db)

    expect(res).toEqual({ ok: true, outcome: 'orphan' })
    expect(db.inserts).toHaveLength(0)
  })
})

describe('fileClientSentReply — the ticket bump', () => {
  it('🔴 clears needs-reply: open + inbound becomes open + outbound', async () => {
    // needs_reply IS the predicate `status = 'open' AND
    // last_message_direction = 'inbound'` (scopeToNeedsReply), so flipping the
    // direction is the whole of the clear.
    const db = makeDb({ messages: [inboundRow()], tickets: [ticketRow()] })

    await file(db)

    const ticket = db._state.email_tickets[0]
    expect(ticket.last_message_direction).toBe('outbound')
    expect(ticket.status).toBe('open')
    expect(ticket.last_message_at).toBe('2026-08-26T09:00:00.000Z')
    expect(ticket.last_message_preview).toBe('No problem — I have moved you to Friday 6pm.')
  })

  it('🔴 does NOT touch status — a closed ticket stays closed', async () => {
    const db = makeDb({
      messages: [inboundRow()],
      tickets: [ticketRow({ status: 'closed', closed_at: '2026-08-26T08:30:00.000Z' })],
    })

    const res = await file(db)

    expect(res).toMatchObject({ ok: true, outcome: 'filed' })
    expect(db._state.email_tickets[0].status).toBe('closed')
    expect(db._state.email_tickets[0].closed_at).toBe('2026-08-26T08:30:00.000Z')
    for (const update of ticketUpdates(db)) {
      expect(update.payload).not.toHaveProperty('status')
      expect(update.payload).not.toHaveProperty('closed_at')
      expect(update.payload).not.toHaveProperty('solved_at')
    }
  })

  it('🔴 does NOT increment unread_count — a staff reply is not a member reply', async () => {
    const db = makeDb({ messages: [inboundRow()], tickets: [ticketRow({ unread_count: 2 })] })

    await file(db)

    expect(db._state.email_tickets[0].unread_count).toBe(2)
    expect(db.rpcs).toHaveLength(0)
    for (const update of ticketUpdates(db)) {
      expect(update.payload).not.toHaveProperty('unread_count')
    }
  })

  it('stamps first_response_at when this is the first outbound message', async () => {
    const db = makeDb({ messages: [inboundRow()], tickets: [ticketRow({ first_response_at: null })] })

    await file(db)

    expect(db._state.email_tickets[0].first_response_at).toBe('2026-08-26T09:00:00.000Z')
  })

  it('leaves an existing first_response_at alone', async () => {
    const db = makeDb({
      messages: [inboundRow()],
      tickets: [ticketRow({ first_response_at: '2026-08-20T10:00:00.000Z' })],
    })

    await file(db)

    expect(db._state.email_tickets[0].first_response_at).toBe('2026-08-20T10:00:00.000Z')
  })

  it('🔴 does NOT clear needs-reply when the member has written again since', async () => {
    // The poller runs up to five minutes behind. Blindly stamping 'outbound'
    // here would drop a ticket the member IS waiting on out of the queue —
    // the double-reply failure this phase exists to prevent, inverted.
    const db = makeDb({
      messages: [inboundRow()],
      tickets: [ticketRow({
        last_message_at: '2026-08-26T09:02:00.000Z',
        last_message_direction: 'inbound',
        last_message_preview: 'Actually, can we make it Saturday?',
      })],
    })

    const res = await file(db, { payload: sentPayload({ date: '2026-08-26T09:00:00.000Z' }) })

    expect(res).toMatchObject({ ok: true, outcome: 'filed' })
    // The reply is on the record …
    expect(messageInserts(db)).toHaveLength(1)
    // … and the ticket still says the member is waiting.
    const ticket = db._state.email_tickets[0]
    expect(ticket.last_message_direction).toBe('inbound')
    expect(ticket.last_message_preview).toBe('Actually, can we make it Saturday?')
  })

  it('does not push the queue sort key into the future on a skewed client clock', async () => {
    const db = makeDb({ messages: [inboundRow()], tickets: [ticketRow()] })

    await file(db, { payload: sentPayload({ date: '2099-01-01T00:00:00.000Z' }) })

    const stamped = db._state.email_tickets[0].last_message_at
    expect(new Date(stamped).getTime()).toBeLessThanOrEqual(Date.now() + 1000)
  })
})

describe('fileClientSentReply — faults are verdicts, never throws', () => {
  it('returns ok:false when the threading lookup fails', async () => {
    const db = makeDb({
      messages: [inboundRow()],
      tickets: [ticketRow()],
      errors: { email_inbox_messages: { code: '42703', message: 'column does not exist' } },
    })

    const res = await file(db)

    expect(res.ok).toBe(false)
    expect(res.reason).toBe('thread_lookup_failed')
    expect(res.error).toMatchObject({ code: '42703' })
  })

  it('returns ok:false when the ticket lookup fails', async () => {
    const db = makeDb({
      messages: [inboundRow()],
      tickets: [ticketRow()],
      errors: { 'email_tickets.select': { code: '08006', message: 'connection failure' } },
    })

    const res = await file(db)

    expect(res).toMatchObject({ ok: false, reason: 'ticket_lookup_failed' })
  })

  it('returns ok:false when the message insert fails for any reason but 23505', async () => {
    const db = makeDb({
      messages: [inboundRow()],
      tickets: [ticketRow()],
      errors: { 'email_inbox_messages.insert': { code: '23503', message: 'foreign key violation' } },
    })

    const res = await file(db)

    expect(res).toMatchObject({ ok: false, reason: 'message_insert_failed' })
    expect(error).toHaveBeenCalled()
  })

  it('returns ok:false when the ticket bump fails, so the caller does not advance', async () => {
    const db = makeDb({
      messages: [inboundRow()],
      tickets: [ticketRow()],
      errors: { 'email_tickets.update': { code: '40001', message: 'serialization failure' } },
    })

    const res = await file(db)

    expect(res).toMatchObject({ ok: false, reason: 'ticket_bump_failed' })
    // The reply is filed either way — the retry lands on the 23505 path.
    expect(messageInserts(db)).toHaveLength(1)
  })

  it('never throws, even when the client itself blows up', async () => {
    const db = { from: () => { throw new TypeError('db is not a db') } }

    const res = await fileClientSentReply(db, { mailbox: MAILBOX, msg: { uid: 1 }, payload: sentPayload() })

    expect(res.ok).toBe(false)
    expect(res.reason).toBe('unexpected')
  })

  it('refuses to run unscoped: a mailbox with no location_id is a fault, not a guess', async () => {
    const db = makeDb({ messages: [inboundRow()], tickets: [ticketRow()] })

    const res = await fileClientSentReply(db, {
      mailbox: { id: MAILBOX.id, address: MAILBOX.address },
      msg: { uid: 1 },
      payload: sentPayload(),
    })

    expect(res).toMatchObject({ ok: false, reason: 'invalid_input' })
    expect(db.inserts).toHaveLength(0)
  })

  it('files without a from_email rather than refusing, when the mailbox address is unusable', async () => {
    const db = makeDb({ messages: [inboundRow()], tickets: [ticketRow()] })

    const res = await file(db, { mailbox: { ...MAILBOX, address: 'not an address' } })

    expect(res).toMatchObject({ ok: true, outcome: 'filed' })
    expect(messageInserts(db)[0].payload.from_email).toBeNull()
  })
})
