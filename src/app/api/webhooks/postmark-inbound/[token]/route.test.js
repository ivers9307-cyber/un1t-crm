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
// EMAIL-INBOUND-PUSH.1 — the fan-out itself (recipient gating, batching,
// own-address suppression) is tested in src/lib/email-inbound-push.test.js;
// here it is mocked so these tests assert WHAT the route hands it and that a
// push failure can never fail the webhook.
vi.mock('@/lib/email-inbound-push', () => ({ maybeNotifyInboundEmail: vi.fn() }))

import { POST, maxDuration } from './route'
import { maybeNotifyInboundEmail } from '@/lib/email-inbound-push'
import { createServerClient } from '@/lib/supabase'
import { deadLetterWebhook } from '@/lib/webhook-dead-letter'
import { recordWebhookEvent } from '@/lib/webhook-events'
import { _resetStormGuardForTests } from '@/lib/error-events'
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
    // .is models SQL IS — null equality, which JS === happens to match for
    // the null/boolean values it is used with here (MAIL-REFINE.1 needed
    // merged tombstones to genuinely not match the subject fallback).
    if (f[0] === 'is') return (row[f[1]] ?? null) === f[2]
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
    // The webhook_events dedupe ledger: eventId → received_at ISO. record-
    // WebhookEvent is mocked, so this is only populated when a test opts into
    // bindDedupeLedger() — but the route's release DELETE always goes through
    // db.from('webhook_events'), which is what clears an entry here, and the
    // stale-claim classifier reads received_at back through the same table.
    claims: new Map(),
    msgSeq: 0,        // email_inbox_messages ids: msg-1, msg-2, …
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
      // The claim ledger, readable: the stale-claim classifier selects
      // received_at for this route's own (provider, event_id) pair.
      case 'webhook_events':
        return applyFilters(
          [...s.claims.entries()].map(([event_id, received_at]) => ({
            provider: 'postmark', event_id, received_at,
          })),
          b._filters,
        )
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
      if (b._table === 'email_inbox_messages') {
        // The unique index on postmark_message_id (the belt-and-braces dedupe
        // layer). Without it modelled, the 23505 finish-up path — the one that
        // re-runs the bump after a crashed/failed first attempt — is untestable.
        const pmId = b._payload?.postmark_message_id
        if (pmId && s.threadRows.some(r => r.postmark_message_id === pmId)) {
          return { data: null, error: { code: '23505', message: 'duplicate key value' } }
        }
        const row = { id: `msg-${++s.msgSeq}`, created_at: new Date().toISOString(), ...b._payload }
        s.threadRows.push(row)
        return { data: row, error: null }
      }
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
    // MAILBOX-PAGE.1 — THE READ THAT DECIDES WHERE A MEMBER'S EMAIL IS FILED
    // MUST BE PAGED, and the fake is where that is enforced.
    //
    // PostgREST caps every select at 1,000 rows whatever the code asks for, so
    // an unpaged `email_mailboxes` read is a silent `LIMIT 1000` with no
    // ORDER BY — past that many active mailboxes, the rows the server happened
    // to return decide the routing. Throwing here means a future edit that
    // drops the paging fails loudly in this suite instead of shipping and
    // waiting for the estate to grow. Mirrors the same guard in the poller's
    // fake client.
    if (b._table === 'email_mailboxes' && b._op === 'select' && !b._range) {
      throw new Error(
        'email_mailboxes was read without .range() — every read of this table must be paginated (see loadActiveMailboxes)'
      )
    }

    let list = rowsFor(b)

    // Ordering is applied BEFORE the slice, exactly as Postgres would: a
    // .range() over an unordered set is the bug this whole change is about.
    if (b._order) {
      const { col, ascending } = b._order
      list = [...list].sort((x, y) => {
        const a = x?.[col]
        const c = y?.[col]
        if (a === c) return 0
        return (a > c ? 1 : -1) * (ascending ? 1 : -1)
      })
    }
    if (b._range) list = list.slice(b._range[0], b._range[1] + 1)

    return shape === 'list' ? { data: list, error: null } : { data: list[0] ?? null, error: null }
  }

  db.from = (table) => {
    const b = { _table: table, _op: 'select', _payload: null, _filters: [], _order: null, _range: null }
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
    // MAILBOX-PAGE.1 — order and range are MODELLED, not stubbed.
    //
    // `.order()` used to be `() => b` and `.range()` did not exist at all,
    // which is a large part of why the unpaginated mailbox read survived: a
    // fake that ignores paging cannot tell a paged read from an unpaged one,
    // so every test passed either way. Same reasoning as the modelled unique
    // indexes above — a fake that does not enforce the thing under test proves
    // nothing.
    b.order = (col, opts) => { b._order = { col, ascending: opts?.ascending !== false }; return b }
    b.range = (from, to) => { b._range = [from, to]; return b }
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
    target._state.claims.set(eventId, new Date().toISOString())
    return { seen: false }
  })
}

/** Plant an already-held claim, aged `ageMs` into the past. */
function holdClaim(target, eventId, ageMs = 0) {
  target._state.claims.set(eventId, new Date(Date.now() - ageMs).toISOString())
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

// MAILBOX-PAGE.1 — the active-mailbox scan is paged, ordered and bounded.
//
// Both readers used to do a bare `.select().eq('active', true)`. PostgREST caps
// every select at 1,000 rows regardless, so that was a silent `LIMIT 1000` with
// no ORDER BY on the ONE query that decides which studio a member's email is
// filed into. Past 1,000 active mailboxes estate-wide, whichever rows the
// server happened to return decided the routing — a message landing in the
// wrong studio, or dead-lettering as `no_matching_mailbox` while its mailbox
// exists and is active. Same class as the "oldest active location" fallback
// this route's header describes removing.
describe('mailbox routing — the scan is paged (MAILBOX-PAGE.1)', () => {
  // Ids sort BEFORE 'mb-hatch' (…'f' < 'h'), so with the scan ordered by id
  // the real mailbox lands past the first page and is only reachable by a
  // reader that asks for the second one.
  const filler = (n) => Array.from({ length: n }, (_, i) => ({
    id: `mb-fill-${String(i).padStart(5, '0')}`,
    location_id: 'loc-filler',
    address: `filler-${i}@example.org`,
    active: true,
    created_at: '2026-01-01T00:00:00Z',
  }))

  it('resolves a mailbox that sits past the first page', async () => {
    // 1,000 fillers push HATCH to index 1000 — the first row of page two, and
    // exactly the row an unpaged read could never see.
    db = makeDb({ mailboxes: [...filler(1000), HATCH] })
    createServerClient.mockImplementation(() => db)

    const res = await post(inbound())

    expect(res.status).toBe(200)
    const tickets = insertsInto(db, 'email_tickets')
    expect(tickets).toHaveLength(1)
    // The point: filed at HATCH's studio, not at a filler's and not nowhere.
    expect(tickets[0].payload.location_id).toBe('loc-hatch')
    expect(deadLetterWebhook).not.toHaveBeenCalled()
  })

  it('stamps a dead-letter location from a mailbox past the first page', async () => {
    // The OTHER reader — bestEffortInboundLocation (DEADLETTER-LOC.1). It was
    // unpaginated too, and it is the one that decides whether a captured
    // payload shows up in the right studio's integration-health count or in
    // nobody's. Unpaged, a mailbox on page two makes this silently NULL.
    db = makeDb({ mailboxes: [...filler(1000), HATCH] })
    createServerClient.mockImplementation(() => db)

    // A sender-less payload: dead-lettered for a reason that is NOT routing,
    // so the recipient still names the mailbox and the location is knowable.
    const res = await post(inbound({ From: undefined, FromFull: undefined }))

    expect(await res.json()).toEqual({ success: true, dead_lettered: 'no_sender' })
    expect(deadLetterWebhook.mock.calls[0][1].locationId).toBe('loc-hatch')
  })

  it('REFUSES rather than resolving against a partial set past the ceiling', async () => {
    // An estate too large to scan cannot prove it holds the mailbox this mail
    // was addressed to, and guessing is exactly what the no-fallback rule
    // forbids. It takes the route's EXISTING mailbox_lookup_failed door — a
    // 500, which releases the dedupe claim so Postmark retries — rather than
    // inventing a new outcome or filing against whatever it managed to read.
    db = makeDb({ mailboxes: filler(10_000) })
    createServerClient.mockImplementation(() => db)

    const res = await post(inbound())

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'mailbox_lookup_failed' })
    // Nothing filed, and NOT dead-lettered as no_matching_mailbox: that would
    // be a 200 and would strand the email on a claim nothing retries.
    expect(insertsInto(db, 'email_tickets')).toHaveLength(0)
    expect(insertsInto(db, 'email_inbox_messages')).toHaveLength(0)
    expect(deadLetterWebhook).not.toHaveBeenCalled()
  })
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
    // location_id stays NULL by design (DEADLETTER-LOC.1): no mailbox matched,
    // so claiming a location would repeat the oldest-active-location bug.
    expect(deadLetterWebhook.mock.calls[0][1].locationId).toBeUndefined()
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

// ── EMAIL-PARTICIPANTS.10 ───────────────────────────────────────────
// A threading header is supplied by the SENDER, and it used to decide which
// contact an inbound was attributed to — resolved from the email_sends row it
// named, BEFORE the route ever looked at who actually sent the mail. A member
// forwards one of our emails to a friend; the friend replies; their References
// still names our original send; their message is written onto the MEMBER's
// contact record, and from there into that member's DSAR export.
//
// It cannot be fixed by looking at From first: "From matches no contact, and a
// header names a send to contact X" describes BOTH a member writing in from a
// second address and a stranger who was forwarded our mail, and nothing in the
// payload separates them. Contact linkage is now the From address or nothing.
describe('contact linkage ignores threading headers (EMAIL-PARTICIPANTS.10)', () => {
  // The send the forwarded copy still carries. email_sends stores Postmark's
  // bare id while the RFC header is `<that-id>@mtasv.net` —
  // extractCandidateMessageIds contributes both forms, so this matches.
  const OUR_SEND = { contact_id: 'c-1', postmark_message_id: 'ours-1', sent_at: '2026-08-06T08:00:00Z' }

  /** Our send in References, a stranger in From. */
  const forwardedReply = (overrides = {}) => inbound({
    MessageID: 'pm-inbound-3',
    From: 'friend@elsewhere.org',
    FromFull: { Email: 'friend@elsewhere.org', Name: 'A Friend' },
    Subject: 'Re: Billing question',
    Headers: [
      { Name: 'Message-ID', Value: '<inbound-3@mail.example.com>' },
      { Name: 'References', Value: '<ours-1@mtasv.net>' },
    ],
    ...overrides,
  })

  it('does not inherit the contact of a send named by References', async () => {
    db = makeDb({ sends: [OUR_SEND] })
    createServerClient.mockImplementation(() => db)

    const res = await post(forwardedReply())

    // Filed — and honestly unlinked, because the From address is nobody we know.
    expect(res.status).toBe(200)
    const [ticket] = insertsInto(db, 'email_tickets')
    expect(ticket.payload.requester_email).toBe('friend@elsewhere.org')
    expect(ticket.payload.contact_id).toBeNull()
    const [message] = insertsInto(db, 'email_inbox_messages')
    expect(message.payload.contact_id).toBeNull()
    // The diagnostic is untouched: the header really did name one of our sends,
    // and saying so is useful. It just no longer confers an identity.
    expect((await res.json()).matched_via).toBe('in_reply_to')
  })

  it('links on the From address even when a header names a send for someone else', async () => {
    db = makeDb({ sends: [{ ...OUR_SEND, contact_id: 'c-someone-else' }] })
    createServerClient.mockImplementation(() => db)

    const res = await post(forwardedReply({
      From: 'member@example.com',
      FromFull: { Email: 'member@example.com', Name: 'Ada Member' },
    }))

    const [ticket] = insertsInto(db, 'email_tickets')
    expect(ticket.payload.contact_id).toBe('c-1')
    expect(ticket.payload.contact_id).not.toBe('c-someone-else')
    expect(insertsInto(db, 'email_inbox_messages')[0].payload.contact_id).toBe('c-1')
    expect((await res.json()).matched_via).toBe('in_reply_to')
  })

  // WHY the email_sends query survived a change that took away its only
  // consumer. Deriving the diagnostic from `candidates.length` — "this payload
  // carries a threading header" — reads like the same statement and is not.
  // email_sends.contact_id is NOT NULL, so a staff reply to an UNLINKED
  // requester writes NO email_sends row at all (compose/reply both build
  // sendLogRow as `contact ? {…} : null`). That requester's later reply then
  // carries a perfectly real In-Reply-To with nothing of ours behind it, and
  // the cheaper test would report it as 'in_reply_to' — quietly widening the
  // diagnostic from "replies to one of OUR SENDS" to "has a header".
  // The row's EXISTENCE is the signal; this test is what says so.
  it('reports from_address when a threading header names no send of ours', async () => {
    // Default fixture: sends is empty, so the In-Reply-To matches nothing.
    const res = await post(reply())

    expect((await res.json()).matched_via).toBe('from_address')
    // …and the linkage still came off the From address, as it now always does.
    expect(insertsInto(db, 'email_tickets')[0].payload.contact_id).toBe('c-1')
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

    // …and the reopen CLEARS the archive stamps (2026-08-08 audit). The
    // statusTimestamps invariant — moving OUT of solved/closed clears them —
    // was honoured by the staff status and reply routes but not here, so a
    // reopened ticket kept its old solved_at, and a later re-solve preserved
    // that stale stamp as though the member's reply never happened.
    expect(update.payload.solved_at).toBeNull()
    expect(update.payload.closed_at).toBeNull()

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

describe('MAIL-REFINE.1 — broken-chain subject fallback', () => {
  // A fresh inbound with NO thread-header match but the same sender + same
  // normalised subject as an OPEN thread of the same mailbox appends to it —
  // some clients start a "reply" as a new email and the chain breaks while
  // the subject survives. The fallback is strictly narrower than threading
  // (open-only, same mailbox, exact key) and FAILS OPEN to create.
  const T_SAME = {
    id: 'T-same', location_id: 'loc-hatch', mailbox_id: 'mb-hatch',
    requester_email: 'member@example.com', status: 'open', merged_into_id: null,
    subject: 'Billing question', first_response_at: null, unread_count: 0,
    last_message_at: '2026-08-30T09:00:00Z',
  }
  const freshWithSubject = (subject, over = {}) => inbound({
    MessageID: 'pm-fresh-9', Subject: subject,
    Headers: [{ Name: 'Message-ID', Value: '<fresh-9@mail.example.com>' }],
    ...over,
  })

  it('appends a chain-broken "Re:" to the open thread with the same subject', async () => {
    db = makeDb({ tickets: { 'T-same': { ...T_SAME } } })
    createServerClient.mockImplementation(() => db)
    const res = await post(freshWithSubject('RE: Billing question'))
    expect(insertsInto(db, 'email_tickets')).toHaveLength(0)
    expect((await res.json()).ticket_id).toBe('T-same')
    expect(insertsInto(db, 'email_inbox_messages')[0].payload.ticket_id).toBe('T-same')
  })

  it('a genuinely different subject still forks a fresh ticket', async () => {
    db = makeDb({ tickets: { 'T-same': { ...T_SAME } } })
    createServerClient.mockImplementation(() => db)
    await post(freshWithSubject('Opening hours over the bank holiday'))
    expect(insertsInto(db, 'email_tickets')).toHaveLength(1)
  })

  it('a CLOSED thread is never resurrected by subject alone', async () => {
    // Only real RFC threading may reopen a closed ticket — a subject match is
    // circumstantial evidence, and "Re: Membership" months later is routinely
    // a new question wearing an old subject.
    db = makeDb({ tickets: { 'T-same': { ...T_SAME, status: 'closed' } } })
    createServerClient.mockImplementation(() => db)
    await post(freshWithSubject('Re: Billing question'))
    expect(insertsInto(db, 'email_tickets')).toHaveLength(1)
  })

  it('another sender with the same subject is a different conversation', async () => {
    db = makeDb({ tickets: { 'T-same': { ...T_SAME, requester_email: 'someone.else@example.com' } } })
    createServerClient.mockImplementation(() => db)
    await post(freshWithSubject('Re: Billing question'))
    expect(insertsInto(db, 'email_tickets')).toHaveLength(1)
  })

  it('a merged tombstone never absorbs new mail', async () => {
    db = makeDb({ tickets: { 'T-same': { ...T_SAME, merged_into_id: 'T-other' } } })
    createServerClient.mockImplementation(() => db)
    await post(freshWithSubject('Re: Billing question'))
    expect(insertsInto(db, 'email_tickets')).toHaveLength(1)
  })

  it('the newest same-key thread wins when several are open', async () => {
    db = makeDb({ tickets: {
      'T-old2': { ...T_SAME, id: 'T-old2', last_message_at: '2026-08-01T09:00:00Z' },
      'T-new2': { ...T_SAME, id: 'T-new2', last_message_at: '2026-08-30T10:00:00Z' },
    } })
    createServerClient.mockImplementation(() => db)
    const res = await post(freshWithSubject('Re: Billing question'))
    expect((await res.json()).ticket_id).toBe('T-new2')
  })

  it('another mailbox\u2019s thread never absorbs this one, even at the same studio', async () => {
    db = makeDb({ tickets: { 'T-same': { ...T_SAME, mailbox_id: 'mb-other' } } })
    createServerClient.mockImplementation(() => db)
    await post(freshWithSubject('Re: Billing question'))
    expect(insertsInto(db, 'email_tickets')).toHaveLength(1)
  })

  it('a wildcard in the SENDER address stays a literal, never a pattern', async () => {
    // fromEmail is attacker-controlled; unescaped ilike would let
    // a_b@example.com absorb axb@example.com's open thread.
    db = makeDb({ tickets: { 'T-same': { ...T_SAME, requester_email: 'axb@example.com' } } })
    createServerClient.mockImplementation(() => db)
    await post(freshWithSubject('Re: Billing question', {
      From: 'a_b@example.com',
      FromFull: { Email: 'a_b@example.com', Name: 'Wild Card' },
    }))
    expect(insertsInto(db, 'email_tickets')).toHaveLength(1)
  })

  it('FAILS OPEN — a broken lookup creates a fresh ticket, never a 5xx', async () => {
    db = makeDb({
      tickets: { 'T-same': { ...T_SAME } },
      fail: { 'email_tickets:select': { code: '08006', message: 'reset' } },
    })
    createServerClient.mockImplementation(() => db)
    const res = await post(freshWithSubject('Re: Billing question'))
    expect(res.status).toBe(200)
    expect(insertsInto(db, 'email_tickets')).toHaveLength(1)
  })
})

describe('idempotency', () => {
  it('returns deduped and writes NOTHING for a MessageID whose message is FILED', async () => {
    // EMAIL-DEDUPE-STALE.1: "seen" alone no longer short-circuits — the claim
    // is only trusted once the message row it promises actually exists.
    recordWebhookEvent.mockResolvedValue({ seen: true })
    db._state.threadRows.push({
      id: 'msg-filed', ticket_id: 'T-open', location_id: 'loc-hatch',
      postmark_message_id: 'pm-inbound-1', created_at: '2026-08-06T09:00:01Z',
    })
    holdClaim(db, 'inbound-email:pm-inbound-1', 5_000)

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
      message_id: 'msg-1',
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
    await post(withAttachments([file({ Name: '../../../../etc/passwd\u0000.pdf' })]))

    const [row] = attachmentRows(db)
    expect(row.storage_path).toBe('loc-hatch/msg-1/0.pdf')
    expect(row.storage_path).not.toContain('..')
    // Kept as data, sanitised: staff still see what the member called it.
    expect(row.filename).not.toContain('/')
    expect(row.filename).not.toContain('\u0000')
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
    // The append-path bump is CHECKED now (it was fire-and-forget): the message
    // is filed, but a lost bump leaves the ticket closed/stale with an unseen
    // reply inside — so it 5xxes, releases, and the retry's 23505 path re-runs it.
    { what: 'the append-path ticket bump', error: 'ticket_bump_failed', fail: { 'email_tickets:update': boom }, payload: reply, claim: REPLY_CLAIM, state: THREADED },
  ]

  let errSpy
  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // The error_events writer is storm-guarded per instance (30/min); this
    // file trips well over 30 failure paths in one window, so each test
    // starts from a clean guard or later rows would silently stop landing.
    _resetStormGuardForTests()
  })
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

      // EMAIL-MONITOR.2 — every 5xx door ALSO lands a structured error_events
      // row (route_type 'handled'), so Sentinel and the error pane can see a
      // failing inbound pipeline without anyone tailing Vercel logs. The
      // founding failure here was fourteen months of 500s that recorded
      // themselves nowhere.
      const evts = insertsInto(db, 'error_events')
      expect(evts.length).toBeGreaterThan(0)
      expect(evts[0].payload.route_type).toBe('handled')
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
    // DEADLETTER-LOC.1 — the recipient still names the mailbox this landed
    // on, so the capture is stamped with its location.
    expect(deadLetterWebhook.mock.calls[0][1].locationId).toBe('loc-hatch')
    // Honest about the state: the claim really is still held.
    expect(db._state.claims.has(CLAIM)).toBe(true)
  })

  it('releases the claim when the route THROWS rather than returning 500', async () => {
    // A genuinely unexpected throw (a malformed Date header used to be the
    // live example; parseEmailDate defused it, so this simulates the next
    // one). Next would answer 500 with the claim still held, which is the
    // same silent loss by another door — the catch-all must keep releasing.
    withDb()
    const realFrom = db.from
    db.from = (table) => {
      if (table === 'email_mailboxes') throw new Error('connection pool exhausted')
      return realFrom(table)
    }

    const res = await post(inbound())

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

// ── EMAIL-DEDUPE-STALE.1 — the crash window ─────────────────────────
// The release-on-5xx above closes the *answered* failure doors, but a claim
// committed BEFORE processing can also be orphaned by a door that never
// answers: a platform kill (Vercel timeout, OOM, crash) between the claim
// insert and the message insert. In-process release never runs, Postmark's
// retry used to find the claim and 200 `deduped`, and the mail was filed
// nowhere. The claim is therefore CLASSIFIED on re-delivery: completed
// (the message row exists — the unique postmark_message_id index is the
// completion marker), in-flight (young claim, first attempt may still be
// writing → 503 keeps the retry chain alive), or stale (older than any
// live request can be → reprocess).
describe('crash window: a seen claim is classified, not blindly trusted', () => {
  const CLAIM = 'inbound-email:pm-inbound-1'

  function withLedgerDb(state) {
    db = makeDb(state)
    createServerClient.mockImplementation(() => db)
    bindDedupeLedger(db)
    return db
  }

  it('exports a maxDuration comfortably under the shim FORWARD_TIMEOUT_MS (30s)', () => {
    // Bounds the crash window: a route the platform kills at maxDuration is
    // dead long before the stale-claim threshold, so "stale ⇒ owner is dead"
    // holds. Also lets the shim relay a real 5xx instead of aborting.
    expect(typeof maxDuration).toBe('number')
    expect(maxDuration).toBeLessThanOrEqual(25)
    expect(maxDuration).toBeGreaterThanOrEqual(10)
  })

  it('answers 503 (not `deduped`) for a YOUNG claim with no filed message', async () => {
    // The first attempt may still be running — a 200 here is exactly the old
    // bug (Postmark stops retrying, the mail is lost if attempt 1 dies), and
    // reprocessing would race a live writer. 5xx keeps the retry chain alive.
    withLedgerDb()
    holdClaim(db, CLAIM, 5_000)

    const res = await post(inbound())

    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('claim_in_flight')
    expect(db.inserts).toHaveLength(0)
    // …and it must NOT release the live owner's claim.
    expect(db.deletes).toHaveLength(0)
    expect(db._state.claims.has(CLAIM)).toBe(true)
  })

  it('REPROCESSES a stale claim with no filed message — the platform-kill mail is filed', async () => {
    // The scenario the audit confirmed: claim committed, process killed before
    // the message insert, retry arrives minutes later. Formerly 200 `deduped`
    // → filed nowhere, forever.
    withLedgerDb()
    holdClaim(db, CLAIM, 120_000)

    const res = await post(inbound())
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.deduped).toBeUndefined()
    expect(json).toMatchObject({ success: true, ticket_id: 'new-ticket', mailbox_id: 'mb-hatch' })
    expect(insertsInto(db, 'email_tickets')).toHaveLength(1)
    expect(insertsInto(db, 'email_inbox_messages')).toHaveLength(1)

    // And a SECOND re-delivery now short-circuits: the message exists.
    const again = await post(inbound())
    expect(await again.json()).toEqual({ success: true, deduped: true })
    expect(db._state.threadRows.filter(r => r.postmark_message_id === 'pm-inbound-1')).toHaveLength(1)
  })

  it('finishes a crashed attempt: stale claim + filed message + missing bump → bump re-run', async () => {
    // Killed between the message insert and the ticket bump: the message
    // exists, the ticket still claims nothing happened. The retry reprocesses,
    // hits the unique index (23505), and the finish-up path completes the bump
    // and the unread increment against the WINNING row's ticket.
    withLedgerDb({
      threadRows: [{
        id: 'msg-crashed', ticket_id: 'T-open', location_id: 'loc-hatch',
        postmark_message_id: 'pm-inbound-1',
        created_at: new Date(Date.now() - 5_000).toISOString(),
      }],
      tickets: {
        'T-open': {
          id: 'T-open', location_id: 'loc-hatch', status: 'open',
          subject: 'Billing question', first_response_at: null,
          last_message_at: '2026-08-01T00:00:00Z', // stale — the bump never landed
        },
      },
    })
    holdClaim(db, CLAIM, 120_000)

    const res = await post(inbound())

    expect(res.status).toBe(200)
    expect((await res.json()).deduped).toBe(true)
    // No second message row.
    expect(db._state.threadRows.filter(r => r.postmark_message_id === 'pm-inbound-1')).toHaveLength(1)
    // The bump landed on the winner's ticket…
    const bump = updatesTo(db, 'email_tickets').find(u => u.filters.some(f => f[2] === 'T-open'))
    expect(bump).toBeTruthy()
    expect(bump.payload.status).toBe('open')
    expect(bump.payload.last_message_direction).toBe('inbound')
    // …and so did the unread increment.
    expect(db.rpcs).toContainEqual({
      fn: 'increment_email_ticket_unread', args: { p_ticket_id: 'T-open' },
    })
  })

  it('does NOT re-bump when the ticket already reflects the message (late manual re-delivery)', async () => {
    // An operator re-sending an already-filed message from Postmark's UI must
    // not reopen a ticket someone closed since: the ticket's last_message_at
    // already covers the winning message, so the finish-up is a no-op.
    const msgAt = new Date(Date.now() - 3600_000).toISOString()
    withLedgerDb({
      threadRows: [{
        id: 'msg-done', ticket_id: 'T-closed', location_id: 'loc-hatch',
        postmark_message_id: 'pm-inbound-1', created_at: msgAt,
      }],
      tickets: {
        'T-closed': {
          id: 'T-closed', location_id: 'loc-hatch', status: 'closed',
          subject: 'Billing question', first_response_at: null,
          last_message_at: msgAt, // the bump landed back then
        },
      },
    })
    holdClaim(db, CLAIM, 7200_000)

    const res = await post(inbound())

    expect(res.status).toBe(200)
    expect((await res.json()).deduped).toBe(true)
    expect(updatesTo(db, 'email_tickets')).toHaveLength(0)
    expect(db.rpcs.map(r => r.fn)).not.toContain('increment_email_ticket_unread')
  })

  it('completes CRASHED attachments on the finish-up path', async () => {
    // Killed between the message insert and the attachment step: the retry's
    // finish-up re-runs storeInboundAttachments against the winning row —
    // idempotent by (message_id, attachment_index), so this is safe even when
    // the crash landed some of the files.
    withLedgerDb({
      threadRows: [{
        id: 'msg-crashed', ticket_id: 'T-open', location_id: 'loc-hatch',
        postmark_message_id: 'pm-inbound-1',
        created_at: new Date(Date.now() - 5_000).toISOString(),
      }],
      tickets: {
        'T-open': {
          id: 'T-open', location_id: 'loc-hatch', status: 'open',
          subject: 'Billing question', first_response_at: null,
          last_message_at: '2026-08-01T00:00:00Z',
        },
      },
    })
    holdClaim(db, CLAIM, 120_000)

    const res = await post(inbound({
      Attachments: [{
        Name: 'invoice.pdf', ContentType: 'application/pdf',
        Content: Buffer.alloc(512).toString('base64'), ContentLength: 987654,
      }],
    }))

    expect(res.status).toBe(200)
    const rows = insertsInto(db, 'email_ticket_attachments').map(i => i.payload)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      message_id: 'msg-crashed', // the WINNING row, not a fresh one
      attachment_index: 0,
      skipped_reason: null,
      size_bytes: 512,
    })
  })
})

// ── EMAIL-INBOUND-POISON.1 — deterministic poison payloads ──────────
// These payloads used to 5xx on EVERY Postmark retry (the payload is identical
// each time), burning the message's whole retry schedule while the mail was
// never filed: a malformed Date header threw out of new Date().toISOString(),
// and NUL bytes / lone UTF-16 surrogates in the text fields failed the
// Postgres insert itself. Both are attacker-suppliable. The fix is to file the
// mail anyway: fall back on the date, strip the unstorable bytes.
describe('poison payloads file instead of 5xx-looping', () => {
  it('a malformed Date header files the mail with the receive time', async () => {
    const res = await post(inbound({ Date: 'not-a-date' }))

    expect(res.status).toBe(200)
    expect((await res.json()).ticket_id).toBe('new-ticket')
    const [message] = insertsInto(db, 'email_inbox_messages')
    expect(Number.isNaN(new Date(message.payload.sent_at).getTime())).toBe(false)
  })

  it('strips NUL bytes from subject, body and display name before the inserts', async () => {
    const res = await post(inbound({
      Subject: 'Bill\u0000ing',
      TextBody: 'pay\u0000ment bounced',
      FromFull: { Email: 'member@example.com', Name: 'Ada\u0000 Member' },
    }))

    expect(res.status).toBe(200)
    const [ticket] = insertsInto(db, 'email_tickets')
    expect(ticket.payload.subject).toBe('Billing')
    expect(ticket.payload.requester_name).toBe('Ada Member')
    const [message] = insertsInto(db, 'email_inbox_messages')
    expect(message.payload.subject).toBe('Billing')
    expect(message.payload.text_body).toBe('payment bounced')
  })

  it('strips a lone surrogate from HtmlBody', async () => {
    await post(inbound({ HtmlBody: '<p>My direct debit bounced\ud800</p>' }))
    const [message] = insertsInto(db, 'email_inbox_messages')
    expect(message.payload.html_body).toBe('<p>My direct debit bounced</p>')
  })

  it('strips NUL from stored threading headers without 5xxing the lookup', async () => {
    const res = await post(inbound({
      Headers: [
        { Name: 'Message-ID', Value: '<inbound-1@mail.example.com>' },
        { Name: 'In-Reply-To', Value: '<ours\u00001@mtasv.net>' },
      ],
    }))

    expect(res.status).toBe(200)
    const [message] = insertsInto(db, 'email_inbox_messages')
    expect(message.payload.in_reply_to).not.toContain('\u0000')
  })

  it('a NUL-bearing From is REJECTED as no sender, never stripped into a real address', async () => {
    // Stripping would merge `a\u0000b@x.com` into a genuine contact's
    // `ab@x.com` — the LIKE-wildcard identity-forgery class again.
    const res = await post(inbound({
      From: 'a\u0000b@example.com',
      FromFull: { Email: 'a\u0000b@example.com', Name: 'Nobody' },
    }))

    expect(res.status).toBe(200)
    expect((await res.json()).dead_lettered).toBe('no_sender')
    expect(insertsInto(db, 'email_tickets')).toHaveLength(0)
  })
})

// ── EMAIL-INBOUND-NOSENDER.1 ────────────────────────────────────────
describe('no parseable sender', () => {
  it('DEAD-LETTERS the payload instead of console-warning it into the void', async () => {
    const res = await post(inbound({ From: undefined, FromFull: undefined }))

    expect(res.status).toBe(200) // retrying will not conjure a sender
    expect(await res.json()).toEqual({ success: true, dead_lettered: 'no_sender' })
    expect(deadLetterWebhook).toHaveBeenCalledTimes(1)
    expect(deadLetterWebhook.mock.calls[0][1]).toMatchObject({
      provider: 'postmark_inbound', // NOT the auto-replayable 'postmark' key
      eventType: 'inbound_email',
      error: 'no_sender',
    })
    expect(deadLetterWebhook.mock.calls[0][1].payload.MessageID).toBe('pm-inbound-1')
    expect(insertsInto(db, 'email_tickets')).toHaveLength(0)
    expect(insertsInto(db, 'email_inbox_messages')).toHaveLength(0)
  })

  it('stamps the recipient mailbox location onto the capture (DEADLETTER-LOC.1)', async () => {
    // No sender ≠ no route: the To address still names the mailbox this
    // landed on. Un-stamped rows are invisible to the per-location
    // integration-health count.
    await post(inbound({ From: undefined, FromFull: undefined }))

    expect(deadLetterWebhook.mock.calls[0][1].locationId).toBe('loc-hatch')
  })

  it('leaves the capture location NULL when the recipient matches no mailbox', async () => {
    await post(inbound({
      From: undefined, FromFull: undefined,
      ToFull: [{ Email: 'nobody@unknown-domain.example' }],
    }))

    expect(deadLetterWebhook).toHaveBeenCalledTimes(1)
    expect(deadLetterWebhook.mock.calls[0][1]).toMatchObject({ error: 'no_sender' })
    expect(deadLetterWebhook.mock.calls[0][1].locationId).toBeNull()
  })

  it('keeps the claim on a no_sender dead-letter (2xx — the payload is captured)', async () => {
    bindDedupeLedger(db)

    await post(inbound({ From: undefined, FromFull: undefined }))

    expect(db.deletes).toHaveLength(0)
    expect(db._state.claims.has('inbound-email:pm-inbound-1')).toBe(true)
  })

  it('parses the display form of From before giving up (Name <addr>)', async () => {
    // Postmark's raw From is a display string. The bare-address parse failed
    // on it, so a payload with no FromFull dropped mail whose sender was in
    // plain sight.
    const res = await post(inbound({
      FromFull: undefined,
      From: 'Ada Member <member@example.com>',
    }))

    expect(res.status).toBe(200)
    expect(deadLetterWebhook).not.toHaveBeenCalled()
    const [ticket] = insertsInto(db, 'email_tickets')
    expect(ticket.payload.requester_email).toBe('member@example.com')
    expect(ticket.payload.contact_id).toBe('c-1')
  })
})

// ── The bump is checked, and the retry completes it ─────────────────
describe('ticket bump failure → retry finishes the job', () => {
  const THREADED = {
    threadRows: [{ ticket_id: 'T-open', created_at: '2026-08-06T08:00:00Z', location_id: 'loc-hatch', rfc_message_id: 'ours-1@mtasv.net' }],
    tickets: { 'T-open': { id: 'T-open', location_id: 'loc-hatch', status: 'open', subject: 'Billing question', first_response_at: null } },
  }
  let errSpy
  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // The error_events writer is storm-guarded per instance (30/min); this
    // file trips well over 30 failure paths in one window, so each test
    // starts from a clean guard or later rows would silently stop landing.
    _resetStormGuardForTests()
  })
  afterEach(() => { errSpy.mockRestore() })

  it('does not increment unread on the attempt whose bump failed — the retry does, once', async () => {
    db = makeDb({ ...THREADED, fail: { 'email_tickets:update': { message: 'update refused' } } })
    createServerClient.mockImplementation(() => db)
    bindDedupeLedger(db)

    // Attempt 1: message filed, bump refused → 500, claim released, NO rpc
    // (incrementing before the 500 would double-count on the retry).
    const first = await post(reply())
    expect(first.status).toBe(500)
    expect((await first.json()).error).toBe('ticket_bump_failed')
    expect(db.rpcs.map(r => r.fn)).not.toContain('increment_email_ticket_unread')

    // The fault clears; Postmark retries. The message insert hits the unique
    // index and the finish-up completes bump + unread against the winner.
    db._state.fail = {}
    const second = await post(reply())
    expect(second.status).toBe(200)
    expect((await second.json()).deduped).toBe(true)

    expect(db._state.threadRows.filter(r => r.postmark_message_id === 'pm-inbound-2')).toHaveLength(1)
    const bumps = updatesTo(db, 'email_tickets').filter(u => u.filters.some(f => f[2] === 'T-open'))
    expect(bumps.length).toBeGreaterThanOrEqual(1)
    expect(db.rpcs.filter(r => r.fn === 'increment_email_ticket_unread')).toHaveLength(1)
  })
})

// ── EMAIL-INBOUND-SHIM.1 — the staged wiring, route-level ───────────
// The shim swaps each attachment's base64 `Content` for a `_un1t_staged`
// marker naming the object it already uploaded. This was the one load-bearing
// piece of the cutover with no route-level test.
describe('shim-staged attachments', () => {
  it('records the staged path and meters the shim-measured bytes, uploading nothing', async () => {
    const res = await post(inbound({
      Attachments: [{
        Name: 'invoice.pdf', ContentType: 'application/pdf',
        ContentLength: 987654, // sender-supplied and wrong on purpose
        Content: '',           // the shim emptied it
        _un1t_staged: { v: 1, path: 'inbound/pm-inbound-1/0.pdf', bytes: 2048 },
      }],
    }))

    expect(res.status).toBe(200)
    const rows = insertsInto(db, 'email_ticket_attachments').map(i => i.payload)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      message_id: 'msg-1',
      mailbox_id: 'mb-hatch',
      attachment_index: 0,
      filename: 'invoice.pdf',
      storage_path: 'inbound/pm-inbound-1/0.pdf', // the shim's key, verbatim
      skipped_reason: null,
      size_bytes: 2048, // the shim's measured DECODED length — never ContentLength
    })
    // Nothing was uploaded here: the bytes are already in the bucket.
    expect([...db._state.objects.keys()]).toHaveLength(0)
    // …but they ARE metered against the delivering mailbox.
    const usage = db._state.usage.find(u => u.mailbox_id === 'mb-hatch')
    expect(usage.bytes_used).toBe(2048)
  })

  it('records a visible skipped row when the shim reports it could not move the bytes', async () => {
    await post(inbound({
      Attachments: [{
        Name: 'invoice.pdf', ContentType: 'application/pdf',
        ContentLength: 4096, Content: '',
        _un1t_staged: { v: 1, error: 'upload_failed' },
      }],
    }))

    const [row] = insertsInto(db, 'email_ticket_attachments').map(i => i.payload)
    expect(row.storage_path).toBeNull()
    expect(row.skipped_reason).toBe('rehost_failed')
    // The message itself is still filed — the governing rule.
    expect(insertsInto(db, 'email_inbox_messages')).toHaveLength(1)
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

// ── EMAIL-CC.1 — the member's own Cc ─────────────────────────────────
//
// The columns landed inert with mig 482 and nothing ever wrote them, so a
// member who cc'd two colleagues arrived looking like a solo enquiry — and a
// staff reply then reached only the sender, dropping those colleagues out of
// their own conversation. Capturing the header is what makes reply-all mean
// anything.
//
// ROUTING MUST NOT MOVE. `recipients` (which merges To and Cc) still decides
// the mailbox, and the threading queries are untouched; these assertions pin
// that the new columns rode along beside that behaviour rather than through it.
describe('inbound Cc capture', () => {
  it('records the member’s Cc list on the message', async () => {
    await post(inbound({
      CcFull: [{ Email: 'Colleague@Example.com' }, { Email: 'boss@example.com' }],
    }))
    const [msg] = insertsInto(db, 'email_inbox_messages')
    expect(msg.payload.cc_emails).toEqual(['colleague@example.com', 'boss@example.com'])
  })

  it('reads the raw Cc header when Postmark sends no CcFull', async () => {
    await post(inbound({ Cc: 'Colleague <colleague@example.com>, boss@example.com' }))
    const [msg] = insertsInto(db, 'email_inbox_messages')
    expect(msg.payload.cc_emails).toEqual(['colleague@example.com', 'boss@example.com'])
  })

  it('records the To list separately from the Cc list', async () => {
    await post(inbound({
      ToFull: [{ Email: HATCH.address }, { Email: 'someone@example.com' }],
      CcFull: [{ Email: 'colleague@example.com' }],
    }))
    const [msg] = insertsInto(db, 'email_inbox_messages')
    expect(msg.payload.to_emails).toEqual([HATCH.address, 'someone@example.com'])
    expect(msg.payload.cc_emails).toEqual(['colleague@example.com'])
    // The scalar is UNCHANGED — still the first entry of the merged recipient
    // list mailbox routing already used.
    expect(msg.payload.to_email).toBe(HATCH.address)
  })

  it('leaves both arrays empty rather than null when there is no Cc', async () => {
    await post(inbound())
    const [msg] = insertsInto(db, 'email_inbox_messages')
    expect(msg.payload.cc_emails).toEqual([])
    expect(msg.payload.to_emails).toEqual([HATCH.address])
  })

  // A Bcc is invisible to the receiving server, so any value here would be a
  // fabrication — and a fabricated bcc is one a reply-all could act on.
  it('NEVER writes bcc_emails on an inbound message', async () => {
    await post(inbound({ Bcc: 'someone@example.com', CcFull: [{ Email: 'c@example.com' }] }))
    const [msg] = insertsInto(db, 'email_inbox_messages')
    expect(msg.payload.bcc_emails).toBeUndefined()
    expect(JSON.stringify(msg.payload)).not.toContain('someone@example.com')
  })

  // A stranger can put 500 addresses in a Cc header, and an unbounded text[]
  // would then be pulled back on every read of this ticket forever.
  it('caps a hostile Cc header at 50 addresses', async () => {
    await post(inbound({
      CcFull: Array.from({ length: 300 }, (_, i) => ({ Email: `a${i}@example.com` })),
    }))
    const [msg] = insertsInto(db, 'email_inbox_messages')
    expect(msg.payload.cc_emails).toHaveLength(50)
  })

  // The property that must NOT have changed. A Cc'd address is still part of
  // the merged recipient list that resolves the mailbox — capturing the header
  // separately is additive, not a re-route.
  it('still routes on the Cc when our mailbox was only cc’d', async () => {
    const res = await post(inbound({
      ToFull: [{ Email: 'someone-else@example.com' }],
      CcFull: [{ Email: HATCH.address }],
    }))
    expect((await res.json()).mailbox_id).toBe('mb-hatch')
    const [ticket] = insertsInto(db, 'email_tickets')
    expect(ticket.payload.location_id).toBe('loc-hatch')
  })
})

// EMAIL-INBOUND-PUSH.1 — the webhook tells staff about inbound mail, the way
// the WhatsApp and Instagram webhooks always have. The route's job here is
// three facts handed to the (mocked) fan-out: the TICKET'S mailbox (which
// decides who may be told), the PRE-increment unread count (the one-ping-per-
// unseen-burst gate), and every address of ours (so our own outbound arriving
// at our own webhook announces nothing) — plus the guarantee that no push
// failure can ever fail the filing.
describe('push fan-out (EMAIL-INBOUND-PUSH.1)', () => {
  it('pushes on a new ticket, carrying mailbox, sender and a zero pre-unread', async () => {
    const res = await post(inbound())

    expect(res.status).toBe(200)
    expect(maybeNotifyInboundEmail).toHaveBeenCalledTimes(1)
    const [dbArg, args] = maybeNotifyInboundEmail.mock.calls[0]
    expect(dbArg).toBe(db)
    expect(args).toMatchObject({
      locationId: 'loc-hatch',
      ticketId: 'new-ticket',
      ticketMailboxId: 'mb-hatch',
      fromEmail: 'member@example.com',
      requesterName: 'Ada Member',
      subject: 'Billing question',
      preUnreadCount: 0,
      // A freshly-created ticket can have no owner (no auto-assign,
      // EMAIL-ASSIGN.1-2) — stated, not implied.
      assignedTo: null,
    })
    // EVERY active address of ours rides along — any studio's, because a
    // cross-studio internal mail is still our own outbound.
    expect(args.ownAddresses).toEqual(expect.arrayContaining([
      'stillorgan@un1tdublin.com', 'accounts@hatchstreetfitness.com',
    ]))
  })

  it('an append carries the TICKET’S mailbox and its pre-increment unread count', async () => {
    // The batching gate: unread 2 means an earlier ping is still outstanding.
    // The route does not decide — it reports the pre-bump state faithfully.
    db = makeDb({
      threadRows: [{ ticket_id: 'T-open', created_at: '2026-08-06T08:00:00Z', location_id: 'loc-hatch', rfc_message_id: 'ours-1@mtasv.net' }],
      tickets: {
        'T-open': {
          id: 'T-open', location_id: 'loc-hatch', status: 'open',
          subject: 'Billing question', first_response_at: null,
          mailbox_id: 'mb-hatch', unread_count: 2,
          // EMAIL-PUSH-ASSIGNEE.1 — an owned ticket's reply pings its owner,
          // so the route must read the owner off the thread's ticket row.
          assigned_to: 'u-claimed',
        },
      },
    })
    createServerClient.mockImplementation(() => db)

    await post(reply())

    expect(maybeNotifyInboundEmail).toHaveBeenCalledTimes(1)
    expect(maybeNotifyInboundEmail.mock.calls[0][1]).toMatchObject({
      ticketId: 'T-open',
      ticketMailboxId: 'mb-hatch',
      preUnreadCount: 2,
      assignedTo: 'u-claimed',
    })
  })

  it('a push failure cannot fail the webhook — the mail is filed and 200 stands', async () => {
    maybeNotifyInboundEmail.mockRejectedValueOnce(new Error('expo down'))

    const res = await post(inbound())

    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
    expect(insertsInto(db, 'email_inbox_messages')).toHaveLength(1)
  })

  it('a dead-lettered recipient pushes nobody', async () => {
    await post(inbound({ ToFull: [{ Email: 'mailbox+samplehash@inbound.postmarkapp.com' }] }))
    expect(maybeNotifyInboundEmail).not.toHaveBeenCalled()
  })

  it('the crash-finish path pushes exactly when it ran the bump the dead attempt missed', async () => {
    // The dead attempt's own push runs AFTER its bump, so a missing bump
    // proves the push never happened either — the finish-up owes both.
    db = makeDb({
      threadRows: [{
        id: 'msg-crashed', ticket_id: 'T-open', location_id: 'loc-hatch',
        postmark_message_id: 'pm-inbound-1',
        created_at: new Date(Date.now() - 5_000).toISOString(),
      }],
      tickets: {
        'T-open': {
          id: 'T-open', location_id: 'loc-hatch', status: 'open',
          subject: 'Billing question', first_response_at: null,
          mailbox_id: 'mb-hatch', unread_count: 0,
          assigned_to: 'u-claimed',
          last_message_at: '2026-08-01T00:00:00Z', // stale — the bump never landed
        },
      },
    })
    createServerClient.mockImplementation(() => db)
    bindDedupeLedger(db)
    holdClaim(db, 'inbound-email:pm-inbound-1', 120_000)

    const res = await post(inbound())

    expect((await res.json()).deduped).toBe(true)
    expect(maybeNotifyInboundEmail).toHaveBeenCalledTimes(1)
    expect(maybeNotifyInboundEmail.mock.calls[0][1]).toMatchObject({
      ticketId: 'T-open',
      ticketMailboxId: 'mb-hatch',
      preUnreadCount: 0,
      fromEmail: 'member@example.com',
      assignedTo: 'u-claimed',
    })
  })

  it('the crash-finish path pushes NOBODY when the bump already landed', async () => {
    // A late manual re-delivery of old, already-handled mail must not ping
    // anyone — same reasoning as not re-bumping the ticket.
    const msgAt = new Date(Date.now() - 3600_000).toISOString()
    db = makeDb({
      threadRows: [{
        id: 'msg-done', ticket_id: 'T-closed', location_id: 'loc-hatch',
        postmark_message_id: 'pm-inbound-1', created_at: msgAt,
      }],
      tickets: {
        'T-closed': {
          id: 'T-closed', location_id: 'loc-hatch', status: 'closed',
          subject: 'Billing question', first_response_at: null,
          mailbox_id: 'mb-hatch', unread_count: 0, last_message_at: msgAt,
        },
      },
    })
    createServerClient.mockImplementation(() => db)
    bindDedupeLedger(db)
    holdClaim(db, 'inbound-email:pm-inbound-1', 7200_000)

    const res = await post(inbound())

    expect((await res.json()).deduped).toBe(true)
    expect(maybeNotifyInboundEmail).not.toHaveBeenCalled()
  })
})

// ── MAIL-SENT.1 — has_inbound is stamped at exactly the inbound writes ───
describe('MAIL-SENT.1 — has_inbound stamps', () => {
  it('a fresh inbound ticket is born has_inbound: true', async () => {
    db = makeDb({})
    createServerClient.mockImplementation(() => db)
    await post(inbound())
    expect(insertsInto(db, 'email_tickets')[0].payload.has_inbound).toBe(true)
  })

  it('the first reply to a compose thread flips it to Inbox on the bump', async () => {
    // An outbound-born (Sent) thread receives its reply via RFC threading —
    // the bump update is the write that moves it from Sent to Inbox.
    db = makeDb({
      threadRows: [{ ticket_id: 'T-sent', created_at: '2026-08-06T08:00:00Z', location_id: 'loc-hatch', rfc_message_id: 'ours-1@mtasv.net' }],
      tickets: { 'T-sent': { id: 'T-sent', location_id: 'loc-hatch', status: 'open', subject: 'Corporate offer', first_response_at: null, has_inbound: false } },
    })
    createServerClient.mockImplementation(() => db)
    await post(reply())
    const update = updatesTo(db, 'email_tickets')[0]
    expect(update.payload.has_inbound).toBe(true)
  })
})
