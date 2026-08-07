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
// The other property under test used to be the DUAL-WRITE — every inbound had
// to produce a mig 394 email_conversations row as well as a ticket. It is now
// the exact opposite (EMAIL-CONV-STOP.1, 2026-08-07): the route must NEVER
// touch that table, and an inbound must still be filed correctly when the table
// is unavailable.
//
// That second half is not defensive padding. The conversation lookup and insert
// answered 500 on failure and both ran BEFORE the ticket insert, so:
//   500 → Postmark retries the same MessageID → recordWebhookEvent already
//   wrote the dedupe row → the retry short-circuits to 200 `deduped` → the
//   email is filed NOWHERE, with no error anywhere.
// One test below makes every email_conversations access throw and asserts the
// mail still lands. It is what says the table can now be dropped safely.
//
// THE THIRD PROPERTY (EMAIL-DEDUPE-RELEASE.1) is that chain closed at its
// source rather than one table at a time: the last describe block breaks each
// of the route's seven 5xx paths in turn and asserts the dedupe claim is
// GIVEN BACK, with the flagship case posting the same MessageID twice and
// asserting the SECOND attempt creates the ticket and the message. The
// counterweight is in there too — a re-delivery of a message that already
// succeeded must still short-circuit to 200 `deduped` and write nothing.

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
import { ilikeMatches } from '@/lib/like-escape.test-helpers'

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
    // ilike applies REAL LIKE semantics (wildcards live). This used to be
    // `lower(a) === lower(b)`, which is what the call site means but not what
    // Postgres does — and that gap is exactly how the wildcard bug below
    // survived a green suite. See src/lib/like-escape.test-helpers.js.
    if (f[0] === 'ilike') return ilikeMatches(f[2], row[f[1]])
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
    // The webhook_events dedupe ledger. recordWebhookEvent is mocked, so this
    // is only populated when a test opts into bindDedupeLedger() — but the
    // route's release DELETE always goes through db.from('webhook_events'),
    // which is what clears an entry here.
    claims: new Set(),
    // EMAIL-ATTACH.1 — attachments, the bucket, and the per-mailbox counter.
    // The counter is MODELLED rather than stubbed: `add_email_storage_bytes`
    // returns the total AFTER its own increment, and that returned value is
    // what decides whether an attachment fits. A stub answering null would make
    // the quota tests pass with the quota check deleted.
    attachments: [],
    objects: new Map(),
    usage: [],
    // `${table}:${op}` → the error that query answers with, so a test can
    // break ONE query the way a real DB fault would. Mutable between requests
    // so a fault can be transient (fail the first attempt, not the retry).
    fail: {},
    ...state,
  }

  const db = { inserts: [], updates: [], deletes: [], rpcs: [], _state: s }

  function rowsFor(b) {
    switch (b._table) {
      case 'email_sends': return applyFilters(s.sends, b._filters)
      case 'email_mailboxes': return applyFilters(s.mailboxes, b._filters)
      case 'contacts': return applyFilters(s.contacts, b._filters)
      case 'email_inbox_messages': return applyFilters(s.threadRows, b._filters)
      case 'email_tickets': return applyFilters(Object.values(s.tickets), b._filters)
      case 'email_ticket_attachments': return applyFilters(s.attachments, b._filters)
      // email_conversations has NO case on purpose: a read falls through to []
      // and a write is still recorded on db.inserts/db.updates, so the negative
      // assertions below can catch a reintroduced dual-write.
      default: return []
    }
  }

  function settle(b, shape) {
    const fault = s.fail[`${b._table}:${b._op}`]
    if (fault) return { data: null, error: fault }

    if (b._op === 'insert') {
      db.inserts.push({ table: b._table, payload: b._payload })
      if (b._table === 'email_ticket_attachments') {
        // UNIQUE (message_id, attachment_index) — mig 496. This is the index
        // that makes storage accounting idempotent across a re-processed
        // inbound email, so the fake has to enforce it or the regression below
        // proves nothing.
        const clash = s.attachments.some(a =>
          a.message_id === b._payload.message_id &&
          a.attachment_index === b._payload.attachment_index)
        if (clash) {
          return { data: null, error: { code: '23505', message: 'duplicate key value' } }
        }
        const row = { id: `att-${s.attachments.length}`, ...b._payload }
        s.attachments.push(row)
        return { data: row, error: null }
      }
      const id = b._table === 'email_tickets' ? 'new-ticket' : 'new-row'
      return { data: { id }, error: null }
    }
    if (b._op === 'update') {
      db.updates.push({ table: b._table, payload: b._payload, filters: b._filters })
      return { data: null, error: null }
    }
    if (b._op === 'delete') {
      db.deletes.push({ table: b._table, filters: b._filters })
      // Model the real effect of the dedupe release: the claim is gone, so
      // the next POST of the same MessageID is processed rather than deduped.
      if (b._table === 'webhook_events') {
        for (const f of b._filters) {
          if (f[0] === 'eq' && f[1] === 'event_id') s.claims.delete(f[2])
        }
      }
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
    b.delete = () => { b._op = 'delete'; return b }
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
    if (fn === 'add_email_storage_bytes') {
      if (s.fail['add_email_storage_bytes']) {
        return Promise.resolve({ data: null, error: s.fail['add_email_storage_bytes'] })
      }
      const mailboxId = args.p_mailbox_id ?? null
      let row = s.usage.find(u => u.location_id === args.p_location_id && (u.mailbox_id ?? null) === mailboxId)
      if (!row) {
        row = { location_id: args.p_location_id, mailbox_id: mailboxId, bytes_used: 0, quota_bytes: 5368709120 }
        s.usage.push(row)
      }
      row.bytes_used = Math.max(0, row.bytes_used + (Number(args.p_delta) || 0))
      return Promise.resolve({ data: row.bytes_used, error: null })
    }
    return Promise.resolve({ data: null, error: null })
  }

  db.storage = {
    from: (bucket) => ({
      upload: (path, bytes, opts) => {
        if (s.fail['storage:upload']) return Promise.resolve({ data: null, error: s.fail['storage:upload'] })
        s.objects.set(`${bucket}/${path}`, { size: bytes?.length ?? 0, opts })
        return Promise.resolve({ data: { path }, error: null })
      },
      remove: (paths) => {
        for (const p of paths) s.objects.delete(`${bucket}/${p}`)
        return Promise.resolve({ data: [], error: null })
      },
      createSignedUrl: (path) => Promise.resolve({ data: { signedUrl: `https://storage.test/${path}` }, error: null }),
    }),
  }

  return db
}

const insertsInto = (db, table) => db.inserts.filter(i => i.table === table)
const updatesTo = (db, table) => db.updates.filter(u => u.table === table)

/**
 * Wire recordWebhookEvent to the fake DB's ledger instead of a fixed answer,
 * so the claim/release cycle is modelled end-to-end: attempt 1 claims, the
 * route's DELETE clears the claim, and attempt 2 with the SAME MessageID is
 * genuinely re-processed rather than short-circuiting. Without this the
 * regression below could not tell a released claim from a held one.
 */
function bindDedupeLedger(target) {
  recordWebhookEvent.mockImplementation(async ({ eventId }) => {
    if (target._state.claims.has(eventId)) return { seen: true }
    target._state.claims.add(eventId)
    return { seen: false }
  })
}

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

// ── Sender → contact matching (the 2026-08-07 wildcard bug) ─────────
// The From address arrives on an UNAUTHENTICATED webhook, so it is
// attacker-controlled, and normalizeEmail's regex (/^[^@\s]+@[^@\s]+\.[^@\s]+$/)
// admits both LIKE wildcards: `_` and `%` are legal email characters. Resolving
// it with a bare .ilike() therefore matched on a PATTERN, not an address.
// See src/lib/like-escape.js.
describe('sender → contact matching resists LIKE wildcards', () => {
  // Two lookalikes: the `_` in the first is a single-character wildcard, so an
  // unescaped pattern also matches the second.
  const UNDERSCORE = { id: 'c-underscore', location_id: 'loc-hatch', email: 'a_b@example.com', created_at: '2025-01-01T00:00:00Z' }
  const LOOKALIKE = { id: 'c-lookalike', location_id: 'loc-hatch', email: 'axb@example.com', created_at: '2024-01-01T00:00:00Z' }

  it('an address containing "_" does not match a DIFFERENT contact', async () => {
    // LOOKALIKE is older, so pickContact prefers it over the real sender —
    // the mismatch is silent and deterministic, never an error.
    db = makeDb({ contacts: [LOOKALIKE, UNDERSCORE] })
    createServerClient.mockImplementation(() => db)

    await post(inbound({ From: 'a_b@example.com', FromFull: { Email: 'a_b@example.com', Name: 'Ada' } }))

    const [ticket] = insertsInto(db, 'email_tickets')
    expect(ticket.payload.requester_email).toBe('a_b@example.com')
    expect(ticket.payload.contact_id).toBe('c-underscore')
    expect(ticket.payload.contact_id).not.toBe('c-lookalike')
  })

  it('"%@domain" does not match every contact at that domain', async () => {
    const many = [
      { id: 'c-alice', location_id: 'loc-hatch', email: 'alice@example.com', created_at: '2024-01-01T00:00:00Z' },
      { id: 'c-bob', location_id: 'loc-hatch', email: 'bob@example.com', created_at: '2024-06-01T00:00:00Z' },
      { id: 'c-carol', location_id: 'loc-hatch', email: 'carol@example.com', created_at: '2025-01-01T00:00:00Z' },
    ]
    db = makeDb({ contacts: many })
    createServerClient.mockImplementation(() => db)

    const res = await post(inbound({ From: '%@example.com', FromFull: { Email: '%@example.com', Name: 'Nobody' } }))

    // The mail is still filed (the mailbox matched) — it just carries NO
    // contact identity, rather than a stranger's.
    const [ticket] = insertsInto(db, 'email_tickets')
    expect(ticket.payload.contact_id).toBeNull()
    expect(ticket.payload.requester_email).toBe('%@example.com')
    // …and the route must not claim it identified the sender.
    expect((await res.json()).matched_via).toBe('recipient_address')
  })

  it('"%@%.%" does not match essentially every contact in the table', async () => {
    db = makeDb({ contacts: [CONTACT, { id: 'c-other', location_id: 'loc-hatch', email: 'someone@elsewhere.org', created_at: '2024-01-01T00:00:00Z' }] })
    createServerClient.mockImplementation(() => db)

    await post(inbound({ From: '%@%.%', FromFull: { Email: '%@%.%', Name: 'Nobody' } }))

    expect(insertsInto(db, 'email_tickets')[0].payload.contact_id).toBeNull()
  })

  it('still matches an ordinary address (the escaping is behaviour-preserving)', async () => {
    // Guards the other direction: over-escaping would break every lookup.
    db = makeDb({ contacts: [{ ...CONTACT, email: 'Member@Example.COM' }] })
    createServerClient.mockImplementation(() => db)

    await post(inbound())

    expect(insertsInto(db, 'email_tickets')[0].payload.contact_id).toBe('c-1')
  })

  it('matches an address that genuinely contains an underscore', async () => {
    db = makeDb({ contacts: [UNDERSCORE] })
    createServerClient.mockImplementation(() => db)

    await post(inbound({ From: 'a_b@example.com', FromFull: { Email: 'a_b@example.com', Name: 'Ada' } }))

    expect(insertsInto(db, 'email_tickets')[0].payload.contact_id).toBe('c-underscore')
  })
})

describe('ticket write (the dual-write is GONE — EMAIL-CONV-STOP.1)', () => {
  it('writes a ticket and a message, and NOTHING into email_conversations', async () => {
    const res = await post(inbound())
    const json = await res.json()

    expect(insertsInto(db, 'email_tickets')).toHaveLength(1)
    expect(insertsInto(db, 'email_conversations')).toHaveLength(0)
    expect(updatesTo(db, 'email_conversations')).toHaveLength(0)

    const [message] = insertsInto(db, 'email_inbox_messages')
    expect(message.payload.ticket_id).toBe('new-ticket')
    expect(message.payload.location_id).toBe('loc-hatch')
    // The column still exists (a later migration drops it) — the route just
    // never names it, so the row is written with conversation_id NULL.
    expect(message.payload).not.toHaveProperty('conversation_id')

    expect(json).toMatchObject({
      success: true,
      ticket_id: 'new-ticket',
      mailbox_id: 'mb-hatch',
    })
    expect(json).not.toHaveProperty('conversation_id')
  })

  it('never reads email_conversations either', async () => {
    // The lookup that used to run here answered 500 on failure, before the
    // ticket insert — the first link in the silent-mail-loss chain.
    const reads = []
    const realFrom = db.from
    db.from = (table) => { reads.push(table); return realFrom(table) }

    await post(inbound())

    expect(reads).not.toContain('email_conversations')
    expect(reads).toContain('email_tickets')
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
    // The legacy unread bump is gone with the conversation row. The RPC itself
    // survives in the database until the migration PR — nothing calls it.
    expect(db.rpcs.map(r => r.fn)).not.toContain('increment_email_conversation_unread')
  })
})

// The reason this change ships BEFORE any DDL.
describe('survives email_conversations being unavailable', () => {
  function breakConversations(target) {
    const realFrom = target.from
    target.from = (table) => {
      if (table === 'email_conversations') {
        throw new Error('relation "public.email_conversations" does not exist')
      }
      return realFrom(table)
    }
  }

  it('files the mail correctly when every access to the table would throw', async () => {
    breakConversations(db)

    const res = await post(inbound())

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({ success: true, ticket_id: 'new-ticket', mailbox_id: 'mb-hatch' })
    // The email is FILED — not 500'd into a Postmark retry that the dedupe row
    // would then swallow as a 200 `deduped`, losing it permanently.
    expect(json.deduped).toBeUndefined()
    expect(insertsInto(db, 'email_tickets')).toHaveLength(1)
    expect(insertsInto(db, 'email_inbox_messages')).toHaveLength(1)
    expect(insertsInto(db, 'email_inbox_messages')[0].payload.ticket_id).toBe('new-ticket')
  })

  it('appends a threaded reply to its ticket with the table unavailable', async () => {
    db = makeDb({
      threadRows: [{ ticket_id: 'T-open', created_at: '2026-08-06T08:00:00Z', location_id: 'loc-hatch', rfc_message_id: 'ours-1@mtasv.net' }],
      tickets: { 'T-open': { id: 'T-open', location_id: 'loc-hatch', status: 'open', subject: 'Billing question', first_response_at: null } },
    })
    createServerClient.mockImplementation(() => db)
    breakConversations(db)

    const res = await post(reply())

    expect(res.status).toBe(200)
    expect((await res.json()).ticket_id).toBe('T-open')
    expect(insertsInto(db, 'email_inbox_messages')[0].payload.ticket_id).toBe('T-open')
  })
})

describe('threading', () => {
  it('appends a reply to the open ticket rather than minting a second', async () => {
    db = makeDb({
      threadRows: [{ ticket_id: 'T-open', created_at: '2026-08-06T08:00:00Z', location_id: 'loc-hatch', rfc_message_id: 'ours-1@mtasv.net' }],
      tickets: { 'T-open': { id: 'T-open', location_id: 'loc-hatch', status: 'open', subject: 'Billing question', first_response_at: null } },
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

  it('REOPENS a closed ticket rather than forking a new one', async () => {
    // Richard, 2026-08-07. Closing is internal bookkeeping — the status route
    // sends the member nothing — so replying to their own old email is simply
    // continuing the conversation. Forking would make our record disagree with
    // the thread sitting in their mail client. RFC threading headers are what
    // separate one issue from the next: a genuinely new enquiry matches no
    // message, resolves to no ticket, and takes the create branch.
    db = makeDb({
      threadRows: [{ ticket_id: 'T-closed', created_at: '2026-07-01T08:00:00Z', location_id: 'loc-hatch', rfc_message_id: 'ours-1@mtasv.net' }],
      tickets: { 'T-closed': { id: 'T-closed', location_id: 'loc-hatch', status: 'closed', subject: 'Billing question', first_response_at: '2026-07-01T09:00:00Z' } },
    })
    createServerClient.mockImplementation(() => db)

    const res = await post(reply())

    // No second ticket.
    expect(insertsInto(db, 'email_tickets')).toHaveLength(0)

    // The closed one comes back to open, and keeps its original subject.
    const update = updatesTo(db, 'email_tickets')[0]
    expect(update.payload.status).toBe('open')
    expect(update.payload).not.toHaveProperty('subject')
    expect(update.filters).toContainEqual(['eq', 'id', 'T-closed'])

    expect(insertsInto(db, 'email_inbox_messages')[0].payload.ticket_id).toBe('T-closed')
    expect((await res.json()).ticket_id).toBe('T-closed')
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
    // …and the short-circuit must not release anyone's claim either.
    expect(db.deletes).toHaveLength(0)
    expect(deadLetterWebhook).not.toHaveBeenCalled()
  })
})

// ── EMAIL-ATTACH.1 ──────────────────────────────────────────────────
// Attachments were the one part of Postmark's payload this route never looked
// at: `Attachments` was ignored outright, so every file a member ever sent was
// discarded on arrival with nothing written anywhere. These tests pin the two
// halves of the fix — the files land AND the bytes are metered — and, more
// importantly, that neither half can ever cost us the email.
describe('attachments (EMAIL-ATTACH.1)', () => {
  const withAttachments = (files) => inbound({ Attachments: files })
  const file = (over = {}) => ({
    Name: 'invoice.pdf',
    ContentType: 'application/pdf',
    Content: Buffer.from('x'.repeat(512)).toString('base64'),
    ContentLength: 987654, // sender-supplied and WRONG on purpose
    ...over,
  })

  const attachmentRows = (d) => insertsInto(d, 'email_ticket_attachments').map(i => i.payload)
  const usageFor = (d, mailboxId) =>
    d._state.usage.find(u => (u.mailbox_id ?? null) === mailboxId) || null

  it('stores the file, records it, and meters the DECODED length', async () => {
    const res = await post(withAttachments([file()]))

    expect(res.status).toBe(200)
    const rows = attachmentRows(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      message_id: 'new-row',
      location_id: 'loc-hatch',
      mailbox_id: 'mb-hatch',   // the mailbox the mail was DELIVERED to
      attachment_index: 0,
      filename: 'invoice.pdf',
      skipped_reason: null,
      size_bytes: 512,           // not 987654, not the base64 length
    })
    expect([...db._state.objects.keys()]).toHaveLength(1)
    expect(usageFor(db, 'mb-hatch').bytes_used).toBe(512)
  })

  it('builds the object key from IDS — an attacker-controlled filename never reaches it', async () => {
    await post(withAttachments([file({ Name: '../../../../etc/passwd .pdf' })]))

    const [row] = attachmentRows(db)
    expect(row.storage_path).toBe('loc-hatch/new-row/0.pdf')
    expect(row.storage_path).not.toContain('..')
    // Kept as data, sanitised: staff still see what the member called it.
    expect(row.filename).not.toContain('/')
    expect(row.filename).not.toContain(' ')
  })

  // THE FLAGSHIP. The dedupe claim is RELEASED on any 5xx precisely so Postmark
  // re-processes, which makes "the same payload twice" a designed-in path.
  // Bytes counted twice would shrink the mailbox's quota permanently with
  // nothing on any screen to explain it.
  it('processes the SAME payload twice and counts the bytes ONCE', async () => {
    bindDedupeLedger(db)
    const payload = withAttachments([file({ Content: Buffer.alloc(2048).toString('base64') })])

    const first = await post(payload)
    expect(first.status).toBe(200)
    expect(usageFor(db, 'mb-hatch').bytes_used).toBe(2048)

    // Give the claim back exactly as a 5xx would, then let Postmark retry.
    db._state.claims.clear()
    const second = await post(payload)
    expect(second.status).toBe(200)

    expect(usageFor(db, 'mb-hatch').bytes_used).toBe(2048) // NOT 4096
    expect(db._state.attachments).toHaveLength(1)
    expect([...db._state.objects.keys()]).toHaveLength(1)
  })

  // THE GOVERNING RULE. Attachments are subordinate to filing the message.
  it('files the message in full when the attachment CANNOT be stored', async () => {
    db._state.fail['storage:upload'] = { message: 'bucket unavailable' }

    const res = await post(withAttachments([file()]))

    // 200, ticket created, message written — exactly as if there were no file.
    expect(res.status).toBe(200)
    expect(insertsInto(db, 'email_tickets')).toHaveLength(1)
    expect(insertsInto(db, 'email_inbox_messages')).toHaveLength(1)

    // …and the file is VISIBLY not stored rather than silently gone.
    const [row] = attachmentRows(db)
    expect(row.storage_path).toBeNull()
    expect(row.skipped_reason).toBe('rehost_failed')
    expect(row.filename).toBe('invoice.pdf')
    expect(row.size_bytes).toBe(512)
    // The reservation was handed back — a failed upload must not eat quota.
    expect(usageFor(db, 'mb-hatch').bytes_used).toBe(0)
  })

  it('files the message even when the whole attachment table is unavailable', async () => {
    db._state.fail['email_ticket_attachments:insert'] = { message: 'table gone' }
    db._state.fail['email_ticket_attachments:select'] = { message: 'table gone' }

    const res = await post(withAttachments([file()]))

    expect(res.status).toBe(200)
    expect((await res.json()).ticket_id).toBe('new-ticket')
    expect(insertsInto(db, 'email_inbox_messages')).toHaveLength(1)
  })

  it('writes no attachment rows for a mail that carries none', async () => {
    await post(inbound())
    expect(attachmentRows(db)).toEqual([])
    expect(db.rpcs.filter(r => r.fn === 'add_email_storage_bytes')).toEqual([])
  })
})

// ── EMAIL-DEDUPE-RELEASE.1 ──────────────────────────────────────────
// The bug this whole file kept describing but never caught:
//   any 5xx → Postmark retries the same MessageID → recordWebhookEvent wrote
//   the dedupe row on attempt 1 → the retry short-circuits to 200 `deduped`
//   → the email is filed NOWHERE. No ticket, no message, no dead letter, no
//   error. The route now DELETEs its own webhook_events row on the way out of
//   any 5xx, so the retry re-processes for real.
describe('a 5xx releases the dedupe claim', () => {
  const CLAIM = 'inbound-email:pm-inbound-1'          // inbound()
  const REPLY_CLAIM = 'inbound-email:pm-inbound-2'    // reply()

  // A reply that threads to an existing open ticket, so the two lookups after
  // the thread scan are actually reached.
  const THREADED = {
    threadRows: [{ ticket_id: 'T-open', created_at: '2026-08-06T08:00:00Z', location_id: 'loc-hatch', rfc_message_id: 'ours-1@mtasv.net' }],
    tickets: { 'T-open': { id: 'T-open', location_id: 'loc-hatch', status: 'open', subject: 'Billing question', first_response_at: null } },
  }

  const boom = { message: 'connection reset by peer' }

  // EVERY 5xx return path in the route, and the query that produces it.
  // If a new one is added without a release, add it here — that is the point.
  const FAILURE_PATHS = [
    { what: 'the email_sends thread lookup', error: 'thread_lookup_failed', fail: { 'email_sends:select': boom }, payload: reply, claim: REPLY_CLAIM },
    { what: 'the email_mailboxes lookup', error: 'mailbox_lookup_failed', fail: { 'email_mailboxes:select': boom }, payload: inbound, claim: CLAIM },
    { what: 'the contacts lookup', error: 'contact_lookup_failed', fail: { 'contacts:select': boom }, payload: inbound, claim: CLAIM },
    { what: 'the email_inbox_messages thread scan', error: 'ticket_lookup_failed', fail: { 'email_inbox_messages:select': boom }, payload: reply, claim: REPLY_CLAIM, state: THREADED },
    { what: 'the email_tickets fetch', error: 'ticket_lookup_failed', fail: { 'email_tickets:select': boom }, payload: reply, claim: REPLY_CLAIM, state: THREADED },
    { what: 'the email_tickets insert', error: 'ticket_insert_failed', fail: { 'email_tickets:insert': boom }, payload: inbound, claim: CLAIM },
    { what: 'the email_inbox_messages insert', error: 'message_insert_failed', fail: { 'email_inbox_messages:insert': boom }, payload: inbound, claim: CLAIM },
  ]

  let errSpy
  beforeEach(() => { errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}) })
  afterEach(() => { errSpy.mockRestore() })

  function withDb(state) {
    db = makeDb(state)
    createServerClient.mockImplementation(() => db)
    bindDedupeLedger(db)
    return db
  }

  for (const { what, error, fail, payload, claim, state } of FAILURE_PATHS) {
    it(`releases it when ${what} fails (${error})`, async () => {
      withDb({ ...(state || {}), fail })

      const res = await post(payload())

      expect(res.status).toBe(500)
      expect((await res.json()).error).toBe(error)

      // Exactly one DELETE, naming THIS route's own (provider, event_id) pair
      // — nothing that could reach another webhook's claim.
      expect(db.deletes).toHaveLength(1)
      expect(db.deletes[0].table).toBe('webhook_events')
      expect(db.deletes[0].filters).toContainEqual(['eq', 'provider', 'postmark'])
      expect(db.deletes[0].filters).toContainEqual(['eq', 'event_id', claim])
      expect(db._state.claims.has(claim)).toBe(false)
    })
  }

  // THE regression test for the whole bug.
  it('the retry after a failed query files the email properly instead of `deduped`', async () => {
    withDb({ fail: { 'email_mailboxes:select': boom } })

    // Attempt 1 — a transient DB fault. Nothing is written.
    const first = await post(inbound())
    expect(first.status).toBe(500)
    expect(insertsInto(db, 'email_tickets')).toHaveLength(0)
    expect(insertsInto(db, 'email_inbox_messages')).toHaveLength(0)

    // The fault clears (that is what transient means) and Postmark retries the
    // SAME MessageID. Before this fix that answered 200 { deduped: true } and
    // wrote nothing — the email was gone, with no error anywhere.
    db._state.fail = {}
    const second = await post(inbound())
    const json = await second.json()

    expect(second.status).toBe(200)
    expect(json.deduped).toBeUndefined()
    expect(json).toMatchObject({ success: true, ticket_id: 'new-ticket', mailbox_id: 'mb-hatch' })

    // The mail is really filed — ticket AND message, on the second attempt.
    expect(insertsInto(db, 'email_tickets')).toHaveLength(1)
    expect(insertsInto(db, 'email_tickets')[0].payload.location_id).toBe('loc-hatch')
    const [message] = insertsInto(db, 'email_inbox_messages')
    expect(message.payload.ticket_id).toBe('new-ticket')
    expect(message.payload.postmark_message_id).toBe('pm-inbound-1')
    expect(message.payload.text_body).toBe('My direct debit bounced.')
  })

  it('a re-delivery of a SUCCESSFUL message still short-circuits to 200 deduped', async () => {
    withDb()

    const first = await post(inbound())
    expect(first.status).toBe(200)
    expect(insertsInto(db, 'email_tickets')).toHaveLength(1)
    // A 2xx KEEPS the claim — this is the half of dedupe that must not change.
    expect(db.deletes).toHaveLength(0)
    expect(db._state.claims.has(CLAIM)).toBe(true)

    const writes = db.inserts.length
    const rpcs = db.rpcs.length
    const second = await post(inbound())

    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ success: true, deduped: true })
    expect(db.inserts).toHaveLength(writes)   // nothing new
    expect(db.rpcs).toHaveLength(rpcs)
    expect(db.deletes).toHaveLength(0)
    expect(deadLetterWebhook).not.toHaveBeenCalled()
  })

  it('a release that FAILS does not mask the original error, and is escalated', async () => {
    withDb({ fail: {
      'email_inbox_messages:insert': { message: 'insert exploded' },
      'webhook_events:delete': { message: 'delete refused' },
    } })

    const res = await post(inbound())

    // The caller still learns what actually broke — not a release error.
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('message_insert_failed')

    // Loud: the retry WILL be swallowed as `deduped` now, so it is logged and
    // the payload is captured where an operator can find it.
    expect(errSpy.mock.calls.some(c => String(c[0]).includes('DEDUPE RELEASE FAILED'))).toBe(true)
    expect(deadLetterWebhook).toHaveBeenCalledTimes(1)
    expect(deadLetterWebhook.mock.calls[0][1]).toMatchObject({
      provider: 'postmark_inbound',   // NOT the auto-replayable 'postmark' key
      eventType: 'inbound_email',
      error: 'dedupe_release_failed',
    })
    expect(deadLetterWebhook.mock.calls[0][1].payload.MessageID).toBe('pm-inbound-1')
    // Honest about the state: the claim really is still held.
    expect(db._state.claims.has(CLAIM)).toBe(true)
  })

  it('releases the claim when the route THROWS rather than returning 500', async () => {
    // A malformed Date header: `new Date('not-a-date').toISOString()` raises a
    // RangeError, and Date is attacker-supplied. Next would answer 500 with
    // the claim still held, which is the same silent loss by another door.
    withDb()

    const res = await post(inbound({ Date: 'not-a-date' }))

    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('unhandled_error')
    expect(db.deletes).toHaveLength(1)
    expect(db._state.claims.has(CLAIM)).toBe(false)
  })

  it('does not release on a 200 dead-letter (unmatched recipient)', async () => {
    // dead_lettered is a 2xx: the payload is already captured and a retry
    // would not conjure a mailbox, so the claim stays.
    withDb()

    const res = await post(inbound({ ToFull: [{ Email: 'nobody@inbound.postmarkapp.com' }] }))

    expect(res.status).toBe(200)
    expect((await res.json()).dead_lettered).toBe('no_matching_mailbox')
    expect(db.deletes).toHaveLength(0)
    expect(db._state.claims.has(CLAIM)).toBe(true)
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
