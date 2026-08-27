// MAILBOX-CONNECT.5 — poller tests.
//
// NOTHING HERE TOUCHES A NETWORK, A MAILBOX OR A DATABASE. Three fakes:
//
//   • a fake IMAP client, injected through the `deps.createClient` seam that
//     imap-connection.js exposes for exactly this. The REAL withMailbox() and
//     the REAL fetchSince() run, so these tests also keep honest the two
//     invariants that live there — the folder is always opened read-only, and
//     the `N:*` range trap is filtered;
//   • a fake supabase client that remembers what was upserted, so the cursor
//     can be asserted as a VALUE rather than as a call;
//   • a fake global fetch standing in for the inbound webhook, which is where
//     the status codes that drive the whole cursor discipline come from.
//
// The tests are organised around the things that must never regress. The one
// that matters most is "a 5xx does NOT advance the watermark": get it
// backwards and mail is lost silently, which is the failure class this entire
// subsystem's history is about.
//
// Since Phase 8 there is a fourth fake — Phase 8A's fileClientSentReply(),
// mocked — because the poller now sweeps two lanes and the 'sent' lane files
// through a writer instead of POSTing. Its four verdicts are the sent lane's
// answer to the same question the HTTP statuses answer for inbox, so §14
// re-states the whole cursor discipline against them rather than trusting that
// "it is the same code" stays true.

import { Readable } from 'node:stream'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

// 🔴 Phase 8A's writer, mocked. It has its own tests; what belongs HERE is
// only the seam — that the sent lane reaches it at all, that the inbox lane
// never does, and that its four verdicts map onto the cursor discipline the
// way the contract says they do.
vi.mock('./sent-lane', () => ({ fileClientSentReply: vi.fn() }))

// Imported back so the LOUD half of several fixes can be asserted. A step-over,
// a dead-letter and a blank body are each "correct" only because an operator is
// told; a test that checked the cursor and not the log would pass on a version
// that lost the message in silence.
import { logError, logWarn } from '../log'
import { fileClientSentReply } from './sent-lane'
import { seal } from './secret-box'
import {
  pollMailbox,
  pollAllMailboxes,
  selectBodyParts,
  backoffMs,
  classifyImapFailure,
  toUidNumber,
  resolveInboundTarget,
  enforceForwardBudget,
} from './imap-poll'

/* ─────────────────────────────── fixtures ─────────────────────────────── */

const MAILBOX = {
  id: '11111111-2222-3333-4444-555555555555',
  location_id: 'loc-1',
  address: 'hatchstreet@un1t.com',
  label: 'Hatch Street',
  active: true,
  ingress: 'imap',
}
const OTHER_MAILBOX = {
  id: '99999999-8888-7777-6666-555555555555',
  location_id: 'loc-2',
  address: 'stillorgan@un1t.com',
  label: 'Stillorgan',
  active: true,
  ingress: 'imap',
}

const NOW = Date.parse('2026-08-26T12:00:00.000Z')
const NOW_ISO = new Date(NOW).toISOString()

function credential(overrides = {}) {
  return {
    mailbox_id: MAILBOX.id,
    provider: 'gmail',
    auth_type: 'password',
    username: 'hatchstreet@un1t.com',
    secret_ciphertext: seal('not-a-real-app-password'),
    oauth_access_token_ciphertext: null,
    oauth_expires_at: null,
    imap_host: 'imap.gmail.com',
    imap_port: 993,
    imap_secure: true,
    sent_folder: '[Gmail]/Sent Mail',
    ...overrides,
  }
}

/** A single-part text/plain message: the root node carries no `part`. */
function plainMessage(uid, { messageId = `m${uid}@x.com`, subject = 'Hello' } = {}) {
  return {
    uid,
    envelope: {
      subject,
      from: [{ name: 'Ada Lovelace', address: 'ada@example.com' }],
      to: [{ name: '', address: 'hatchstreet@un1t.com' }],
      date: new Date('2026-08-26T11:00:00.000Z'),
      messageId,
    },
    internalDate: new Date('2026-08-26T11:00:02.000Z'),
    bodyStructure: { type: 'text/plain', encoding: 'quoted-printable', size: 120 },
    headers: Buffer.from(`Message-ID: <${messageId}>\r\nSubject: ${subject}\r\n`),
  }
}

/** multipart/alternative — text/plain at part 1, text/html at part 2. */
function alternativeMessage(uid, { messageId = `m${uid}@x.com` } = {}) {
  const msg = plainMessage(uid, { messageId })
  msg.bodyStructure = {
    type: 'multipart/alternative',
    childNodes: [
      { part: '1', type: 'text/plain', encoding: '7bit', size: 30 },
      { part: '2', type: 'text/html', encoding: 'quoted-printable', size: 90 },
    ],
  }
  return msg
}

/**
 * What a reply typed in Gmail looks like once it lands in the Sent folder:
 * FROM the connected mailbox, TO the member, carrying the threading headers
 * that let Phase 8A find the ticket.
 */
function sentMessage(uid, { messageId = `s${uid}@mail.gmail.com`, inReplyTo = '<m11@x.com>' } = {}) {
  return {
    uid,
    envelope: {
      subject: 'Re: Hello',
      from: [{ name: 'Hatch Street', address: 'hatchstreet@un1t.com' }],
      to: [{ name: 'Ada Lovelace', address: 'ada@example.com' }],
      date: new Date('2026-08-26T11:30:00.000Z'),
      messageId,
    },
    internalDate: new Date('2026-08-26T11:30:01.000Z'),
    bodyStructure: { type: 'text/plain', encoding: '7bit', size: 40 },
    headers: Buffer.from(
      `Message-ID: <${messageId}>\r\nIn-Reply-To: ${inReplyTo}\r\nReferences: ${inReplyTo}\r\nSubject: Re: Hello\r\n`,
    ),
  }
}

/* ───────────────────────────── the fake IMAP ──────────────────────────── */

/**
 * A stand-in for ImapFlow. `timeline` is shared with the fake fetch so the
 * ORDER of "download the body" against "POST the payload" can be asserted —
 * that ordering is the difference between a real ticket and a blank one.
 */
function fakeImap({
  uidValidity = 12345n,
  uidNext = 11,
  messages = [],
  bodies = {},
  failAt = null,
  timeline = [],
} = {}) {
  const client = {
    timeline,
    async connect() {
      timeline.push('connect')
      if (failAt === 'connect') throw new Error('ECONNREFUSED imap.gmail.com:993')
      if (failAt === 'auth') {
        const err = new Error('Invalid credentials (Failure)')
        err.authenticationFailed = true
        err.serverResponseCode = 'AUTHENTICATIONFAILED'
        throw err
      }
    },
    async mailboxOpen(path, opts) {
      timeline.push(['mailboxOpen', path, opts])
      return { path, uidValidity, uidNext, exists: messages.length, readOnly: true }
    },
    async *fetch() {
      timeline.push('fetch')
      for (const msg of messages) yield msg
    },
    async download(uid, part) {
      timeline.push(['download', String(uid), part])
      const entry = bodies[`${uid}:${part}`]
      if (entry === undefined) throw new Error(`no such part ${part}`)
      if (entry instanceof Error) throw entry
      const text = typeof entry === 'string' ? entry : entry.text
      const charset = typeof entry === 'string' ? 'utf-8' : entry.charset
      return {
        meta: { charset },
        content: Readable.from([Buffer.from(text, charset === 'utf-8' ? 'utf8' : 'binary')]),
      }
    },
    async downloadMany() { return {} },
    async logout() { timeline.push('logout') },
  }
  return { client, deps: { createClient: () => client } }
}

/**
 * A fake IMAP whose contents depend on WHICH FOLDER was opened.
 *
 * The single-folder fake above cannot express the thing the sent lane is for:
 * a mailbox where INBOX holds a member's question and `[Gmail]/Sent Mail`
 * holds the colleague's answer. Keyed by the real IMAP path, so a test that
 * expects the Sent lane to open `[Gmail]/Sent Mail` fails loudly if the lane
 * ever resolves somewhere else.
 */
function fakeImapByFolder(byPath, { timeline = [] } = {}) {
  let current = { uidValidity: 12345n, uidNext: 1, messages: [], bodies: {} }
  const client = {
    timeline,
    async connect() { timeline.push('connect') },
    async mailboxOpen(path, opts) {
      timeline.push(['mailboxOpen', path, opts])
      current = { uidValidity: 12345n, uidNext: 1, messages: [], bodies: {}, ...(byPath[path] || {}) }
      return {
        path,
        uidValidity: current.uidValidity,
        uidNext: current.uidNext,
        exists: current.messages.length,
        readOnly: true,
      }
    },
    async *fetch() {
      timeline.push('fetch')
      for (const msg of current.messages) yield msg
    },
    async download(uid, part) {
      timeline.push(['download', String(uid), part])
      const entry = current.bodies[`${uid}:${part}`]
      if (entry === undefined) throw new Error(`no such part ${part}`)
      return { meta: { charset: 'utf-8' }, content: Readable.from([Buffer.from(String(entry), 'utf8')]) }
    },
    async downloadMany() { return {} },
    async logout() { timeline.push('logout') },
  }
  return { client, timeline, deps: { createClient: () => client } }
}

/* ─────────────────────────────── the fake db ──────────────────────────── */

/**
 * Enough supabase-js to run the poller: the four reads it does, plus an
 * upsert that WRITES BACK into the seeded cursor map, so a second poll in the
 * same test sees what the first one recorded.
 *
 * `.order()` and `.range()` are modelled rather than ignored, because the
 * poller's mailbox reads are RANGE-PAGINATED (the 1,000-row-cap invariant) and
 * a fake that silently returned everything on the first page would let the
 * pagination rot untested — which is exactly how the `.limit(200)` starvation
 * bug survived review in the first place.
 *
 * The `email_mailboxes` table is read TWICE with different filters and the fake
 * tells them apart the same way the code does: the poll list carries an
 * `ingress` filter, the cross-tenant address list does not.
 */
function makeDb(seed = {}) {
  const state = {
    mailboxes: seed.mailboxes || [],
    credentials: new Map(Object.entries(seed.credentials || {})),
    ingress: new Map(Object.entries(seed.ingress || {})),
    errors: seed.errors || {},
    upserts: [],
    uploads: [],
    removed: [],
    reads: [],
  }

  const key = (mailboxId, folder) => `${mailboxId}:${folder}`

  function chain(table) {
    const filters = {}
    let bounds = null
    const api = {
      select() { return api },
      eq(col, val) { filters[col] = val; return api },
      in(col, vals) { filters[col] = vals; return api },
      limit() { return api },
      order(col) { filters._order = col; return api },
      range(from, to) { bounds = [from, to]; return api },
      async maybeSingle() {
        if (table === 'email_mailbox_credentials') {
          if (state.errors.credentials) return { data: null, error: state.errors.credentials }
          return { data: state.credentials.get(filters.mailbox_id) || null, error: null }
        }
        if (table === 'email_mailbox_ingress') {
          if (state.errors.cursor) return { data: null, error: state.errors.cursor }
          return { data: state.ingress.get(key(filters.mailbox_id, filters.folder)) || null, error: null }
        }
        throw new Error(`unexpected maybeSingle on ${table}`)
      },
      upsert(row) {
        state.upserts.push({ table, row })
        const existing = state.ingress.get(key(row.mailbox_id, row.folder)) || {}
        state.ingress.set(key(row.mailbox_id, row.folder), { ...existing, ...row })
        const result = state.errors.upsert ? { error: state.errors.upsert } : { error: null }
        return { then: (f, r) => Promise.resolve(result).then(f, r) }
      },
      then(onFulfilled, onRejected) {
        let result
        if (table === 'email_mailboxes') {
          // The address read has no `ingress` filter; the poll list does.
          const isAddressRead = filters.ingress === undefined
          state.reads.push(isAddressRead ? 'addresses' : 'pollable')
          const failure = isAddressRead
            ? (state.errors.addresses || state.errors.mailboxes)
            : state.errors.mailboxes
          if (failure) {
            result = { data: null, error: failure }
          } else {
            const rows = state.mailboxes
              .filter(m => (filters.ingress === undefined || m.ingress === filters.ingress))
              .filter(m => (filters.active === undefined || m.active === filters.active))
              .slice()
              .sort((a, b) => String(a.id).localeCompare(String(b.id)))
            // An unpaginated read of this table is the bug the poller just
            // fixed, so the fake refuses to answer one.
            if (!bounds) throw new Error('email_mailboxes must be read with .range()')
            result = { data: rows.slice(bounds[0], bounds[1] + 1), error: null }
          }
        } else if (table === 'email_mailbox_ingress') {
          const ids = filters.mailbox_id || []
          result = state.errors.order
            ? { data: null, error: state.errors.order }
            : { data: ids.map(id => state.ingress.get(key(id, filters.folder))).filter(Boolean), error: null }
        } else {
          throw new Error(`unexpected list read on ${table}`)
        }
        return Promise.resolve(result).then(onFulfilled, onRejected)
      },
    }
    return api
  }

  return {
    state,
    from: (table) => chain(table),
    storage: {
      from: () => ({
        upload: async (path, bytes, opts) => {
          state.uploads.push({ path, bytes, opts })
          return { error: null }
        },
        remove: async (paths) => {
          state.removed.push(...paths)
          return { error: null }
        },
      }),
    },
  }
}

/** The cursor row the poller last wrote for (mailbox, folder). */
function lastCursor(db, mailboxId = MAILBOX.id, folder = 'inbox') {
  const rows = db.state.upserts.filter(u => u.row.mailbox_id === mailboxId && u.row.folder === folder)
  return rows.length ? rows[rows.length - 1].row : null
}

/* ────────────────────────────── the fake fetch ────────────────────────── */

function stubFetch({ status = 200, timeline = [], statuses = null } = {}) {
  const calls = []
  let i = 0
  const fn = vi.fn(async (url, init) => {
    timeline.push('POST')
    const body = JSON.parse(init.body)
    calls.push({ url, body, headers: init.headers })
    const code = statuses ? (statuses[i++] ?? statuses[statuses.length - 1]) : status
    return {
      status: code,
      async text() { return JSON.stringify({ success: code < 300 }) },
    }
  })
  vi.stubGlobal('fetch', fn)
  return { fn, calls }
}

beforeEach(() => {
  process.env.MAILBOX_SECRET_KEY = Buffer.alloc(32, 7).toString('base64')
  process.env.POSTMARK_EMAIL_INBOX_WEBHOOK_TOKEN = 'inbound-token-abc'
  process.env.CRM_WEBHOOK_BASE_URL = 'https://crm.example.test'
  vi.clearAllMocks()
  // The happy verdict, so a test that is not ABOUT the writer's answer does
  // not have to state one. Set after clearAllMocks, which clears calls only —
  // an implementation set once at module scope would survive, but stating it
  // here is what makes each test's override obviously an override.
  fileClientSentReply.mockResolvedValue({ ok: true, outcome: 'filed', ticketId: 'tkt-1', messageId: 'msg-1' })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/* ═══════════════════════════ 1. cold start ════════════════════════════ */

describe('cold start', () => {
  it('🔴 anchors the watermark and ingests NOTHING', async () => {
    // §3.5. The alternative — treating an unanchored mailbox as "everything is
    // new" — files years of a customer's correspondence as fresh tickets, with
    // push notifications. There is no backfill, ever.
    const timeline = []
    const { fn } = stubFetch({ timeline })
    const { deps, client } = fakeImap({ uidNext: 431, messages: [plainMessage(430)], timeline })
    const db = makeDb({ credentials: { [MAILBOX.id]: credential() } })

    const out = await pollMailbox(db, MAILBOX, { now: NOW, deps })

    expect(out).toMatchObject({ ok: true, ingested: 0, skipped: 0, reason: 'cold_start' })
    expect(fn).not.toHaveBeenCalled()

    const cursor = lastCursor(db)
    // uidNext is the NEXT uid to be handed out, so the highest that exists is
    // one below it — everything currently in the folder is behind the mark.
    expect(cursor.last_uid).toBe(430)
    expect(cursor.uidvalidity).toBe(12345)
    expect(cursor.last_ok_at).toBe(NOW_ISO)
    expect(cursor.consecutive_failures).toBe(0)

    // Still read-only, still logged out — the Wave 1 invariants, exercised
    // through the real withMailbox().
    expect(client.timeline).toContainEqual(['mailboxOpen', 'INBOX', { readOnly: true }])
    expect(client.timeline).toContain('logout')
  })

  it('anchors an EMPTY mailbox at 0, which is a legal cursor', async () => {
    const { deps } = fakeImap({ uidNext: 1, messages: [] })
    const db = makeDb({ credentials: { [MAILBOX.id]: credential() } })
    stubFetch({})

    const out = await pollMailbox(db, MAILBOX, { now: NOW, deps })

    expect(out.reason).toBe('cold_start')
    expect(lastCursor(db).last_uid).toBe(0)
  })

  it('🔴 refuses to anchor when the server reports no usable UIDNEXT', async () => {
    // Anchoring at 0 on a guess would make the NEXT tick fetch `1:*` and file
    // the entire mailbox. Failing the tick costs five minutes.
    const { deps } = fakeImap({ uidNext: null })
    const db = makeDb({ credentials: { [MAILBOX.id]: credential() } })

    const out = await pollMailbox(db, MAILBOX, { now: NOW, deps })

    expect(out.ok).toBe(false)
    expect(out.reason).toBe('connect_failed')
    expect(lastCursor(db).last_uid).toBeUndefined()
  })
})

/* ══════════════════════ 2. the watermark discipline ═══════════════════ */

describe('the watermark advances only on a 2xx', () => {
  const seededCursor = {
    mailbox_id: MAILBOX.id, folder: 'inbox', uidvalidity: 12345, last_uid: 10,
    consecutive_failures: 0, paused_until: null,
  }

  it('advances on a 2xx, and posts a Postmark-shaped payload at the token URL', async () => {
    const timeline = []
    const { fn, calls } = stubFetch({ status: 200, timeline })
    const { deps } = fakeImap({
      uidNext: 13,
      messages: [plainMessage(11), plainMessage(12)],
      bodies: { '11:1': 'first body', '12:1': 'second body' },
      timeline,
    })
    const db = makeDb({
      credentials: { [MAILBOX.id]: credential() },
      ingress: { [`${MAILBOX.id}:inbox`]: seededCursor },
    })

    const out = await pollMailbox(db, MAILBOX, { now: NOW, deps })

    expect(out).toMatchObject({ ok: true, ingested: 2, skipped: 0 })
    expect(fn).toHaveBeenCalledTimes(2)
    expect(calls[0].url).toBe('https://crm.example.test/api/webhooks/postmark-inbound/inbound-token-abc')

    const payload = calls[0].body
    // OriginalRecipient is the field that routes the mail — without it the
    // route dead-letters as no_matching_mailbox.
    expect(payload.OriginalRecipient).toBe('hatchstreet@un1t.com')
    expect(payload.MessageID).toMatch(/^imap-[0-9a-f]{8}-[0-9a-f]{40}$/)
    expect(payload.FromFull).toEqual({ Email: 'ada@example.com', Name: 'Ada Lovelace' })
    expect(payload.Headers.find(h => h.Name === 'Message-ID').Value).toBe('<m11@x.com>')

    const cursor = lastCursor(db)
    expect(cursor.last_uid).toBe(12)
    expect(cursor.last_ok_at).toBe(NOW_ISO)
    expect(cursor.last_error).toBeNull()
    expect(cursor.consecutive_failures).toBe(0)
  })

  it('🔴 a 5xx does NOT advance the watermark, and stops the mailbox for this tick', async () => {
    // THE test. A 5xx means the route did not record the message — its dedupe
    // claim is released on every >= 500 precisely so the retry re-processes.
    // Advancing here would drop the message on the floor, silently, forever.
    const { fn, calls } = stubFetch({ status: 500 })
    const { deps } = fakeImap({
      uidNext: 14,
      messages: [plainMessage(11), plainMessage(12), plainMessage(13)],
      bodies: { '11:1': 'a', '12:1': 'b', '13:1': 'c' },
    })
    const db = makeDb({
      credentials: { [MAILBOX.id]: credential() },
      ingress: { [`${MAILBOX.id}:inbox`]: seededCursor },
    })

    const out = await pollMailbox(db, MAILBOX, { now: NOW, deps })

    expect(out).toMatchObject({ ok: false, ingested: 0, reason: 'forward_failed' })
    // It stops at the first refusal rather than marching on: every later
    // message would have to jump the cursor over this one to be filed.
    expect(fn).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(1)

    const cursor = lastCursor(db)
    expect(cursor.last_uid).toBeUndefined() // untouched — still 10 on the row
    expect(cursor.last_ok_at).toBeUndefined() // a mailbox that cannot deliver is not healthy
    expect(cursor.consecutive_failures).toBe(1)
    expect(db.state.ingress.get(`${MAILBOX.id}:inbox`).last_uid).toBe(10)
  })

  it('🔴 keeps what it earned: a 5xx after a 2xx advances to the LAST accepted uid', async () => {
    const { deps } = fakeImap({
      uidNext: 14,
      messages: [plainMessage(11), plainMessage(12), plainMessage(13)],
      bodies: { '11:1': 'a', '12:1': 'b', '13:1': 'c' },
    })
    stubFetch({ statuses: [200, 503, 200] })
    const db = makeDb({
      credentials: { [MAILBOX.id]: credential() },
      ingress: { [`${MAILBOX.id}:inbox`]: seededCursor },
    })

    const out = await pollMailbox(db, MAILBOX, { now: NOW, deps })

    expect(out).toMatchObject({ ok: false, ingested: 1, reason: 'forward_failed' })
    const cursor = lastCursor(db)
    expect(cursor.last_uid).toBe(11) // 12 is retried next tick, 13 sits behind it
    expect(cursor.last_ok_at).toBeUndefined()
  })

  it('a network failure or timeout is treated exactly like a 5xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('The operation was aborted due to timeout') }))
    const { deps } = fakeImap({
      uidNext: 12, messages: [plainMessage(11)], bodies: { '11:1': 'a' },
    })
    const db = makeDb({
      credentials: { [MAILBOX.id]: credential() },
      ingress: { [`${MAILBOX.id}:inbox`]: seededCursor },
    })

    const out = await pollMailbox(db, MAILBOX, { now: NOW, deps })

    expect(out.ok).toBe(false)
    expect(out.reason).toBe('forward_failed')
    expect(db.state.ingress.get(`${MAILBOX.id}:inbox`).last_uid).toBe(10)
  })

  it('🔴 a 400 steps OVER the message rather than stalling every email behind it', async () => {
    // The route answers 400 only for input it can never accept. Retrying is
    // guaranteed to fail identically, so the real choice is between losing one
    // message and losing every message after it.
    const { fn } = stubFetch({ statuses: [400, 200] })
    const { deps } = fakeImap({
      uidNext: 13,
      messages: [plainMessage(11), plainMessage(12)],
      bodies: { '11:1': 'a', '12:1': 'b' },
    })
    const db = makeDb({
      credentials: { [MAILBOX.id]: credential() },
      ingress: { [`${MAILBOX.id}:inbox`]: seededCursor },
    })

    const out = await pollMailbox(db, MAILBOX, { now: NOW, deps })

    expect(out).toMatchObject({ ok: true, ingested: 1, skipped: 1 })
    expect(fn).toHaveBeenCalledTimes(2)
    expect(lastCursor(db).last_uid).toBe(12)
  })

  it('a 200 that dead-lettered still advances — it IS recorded somewhere a human can see', async () => {
    stubFetch({ status: 200 })
    const { deps } = fakeImap({
      uidNext: 12, messages: [plainMessage(11)], bodies: { '11:1': 'a' },
    })
    const db = makeDb({
      credentials: { [MAILBOX.id]: credential() },
      ingress: { [`${MAILBOX.id}:inbox`]: seededCursor },
    })

    const out = await pollMailbox(db, MAILBOX, { now: NOW, deps })
    expect(out.ingested).toBe(1)
    expect(lastCursor(db).last_uid).toBe(11)
  })

  it('fetchSince’s N:* filter holds: a tick with no new mail writes no watermark and posts nothing', async () => {
    // An empty IMAP range still returns the highest existing UID, which is why
    // fetchSince filters `> sinceUid`. Exercised here through the real one.
    const { fn } = stubFetch({})
    const { deps } = fakeImap({ uidNext: 11, messages: [plainMessage(10)] })
    const db = makeDb({
      credentials: { [MAILBOX.id]: credential() },
      ingress: { [`${MAILBOX.id}:inbox`]: seededCursor },
    })

    const out = await pollMailbox(db, MAILBOX, { now: NOW, deps })

    expect(out).toMatchObject({ ok: true, ingested: 0, skipped: 0 })
    expect(fn).not.toHaveBeenCalled()
    expect(lastCursor(db).last_uid).toBeUndefined()
    expect(lastCursor(db).last_ok_at).toBe(NOW_ISO)
  })
})

/* ══════════════════════════ 3. UIDVALIDITY ════════════════════════════ */

describe('UIDVALIDITY', () => {
  it('🔴 a change RE-ANCHORS without re-ingesting a single message', async () => {
    const { fn } = stubFetch({})
    const { deps } = fakeImap({
      uidValidity: 777n, uidNext: 51, messages: [plainMessage(50)],
    })
    const db = makeDb({
      credentials: { [MAILBOX.id]: credential() },
      ingress: {
        [`${MAILBOX.id}:inbox`]: {
          mailbox_id: MAILBOX.id, folder: 'inbox', uidvalidity: 12345, last_uid: 10,
          consecutive_failures: 0, paused_until: null,
        },
      },
    })

    const out = await pollMailbox(db, MAILBOX, { now: NOW, deps })

    expect(out).toMatchObject({ ok: true, ingested: 0, skipped: 0, reason: 'uidvalidity_changed' })
    expect(fn).not.toHaveBeenCalled()
    const cursor = lastCursor(db)
    expect(cursor.uidvalidity).toBe(777)
    expect(cursor.last_uid).toBe(50)
  })

  it('🔴 a BigInt from imapflow equals a Number from PostgREST — no re-anchor loop', async () => {
    // `12345n !== 12345` is TRUE. Comparing the two raw would re-anchor on
    // EVERY tick, so the mailbox would never ingest anything while every row
    // and log line said the poll succeeded. Both sides go through
    // toUidNumber() for exactly this reason.
    stubFetch({ status: 200 })
    const { deps } = fakeImap({
      uidValidity: 12345n, uidNext: 12, messages: [plainMessage(11)], bodies: { '11:1': 'a' },
    })
    const db = makeDb({
      credentials: { [MAILBOX.id]: credential() },
      ingress: {
        [`${MAILBOX.id}:inbox`]: {
          mailbox_id: MAILBOX.id, folder: 'inbox', uidvalidity: 12345, last_uid: 10,
          consecutive_failures: 0, paused_until: null,
        },
      },
    })

    const out = await pollMailbox(db, MAILBOX, { now: NOW, deps })

    expect(out.reason).toBeUndefined() // NOT 'uidvalidity_changed'
    expect(out.ingested).toBe(1)
    // And what goes back to the database is a Number, because JSON.stringify
    // throws on a BigInt and would have failed the cursor write.
    expect(typeof lastCursor(db).uidvalidity).toBe('number')
  })

  it('a bigint arriving as a STRING (past 2^53 territory) still compares equal', () => {
    expect(toUidNumber('12345')).toBe(12345)
    expect(toUidNumber(12345n)).toBe(12345)
    expect(toUidNumber(null)).toBeNull()
    expect(toUidNumber('not a number')).toBeNull()
  })
})

/* ═══════════════════════ 4. bodies before mapping ═════════════════════ */

describe('bodies', () => {
  it('🔴 downloads and attaches the bodies BEFORE the payload is built', async () => {
    // toInboundPayload() is pure and reads msg.text / msg.html. Map first and
    // every member's email files as a BLANK TICKET — no error, no log line,
    // nothing on any screen. This test is the only thing standing between that
    // regression and production.
    const timeline = []
    const { calls } = stubFetch({ timeline })
    const { deps } = fakeImap({
      uidNext: 12,
      messages: [alternativeMessage(11)],
      bodies: { '11:1': 'the plain text', '11:2': '<p>the html</p>' },
      timeline,
    })
    const db = makeDb({
      credentials: { [MAILBOX.id]: credential() },
      ingress: {
        [`${MAILBOX.id}:inbox`]: {
          mailbox_id: MAILBOX.id, folder: 'inbox', uidvalidity: 12345, last_uid: 10,
          consecutive_failures: 0, paused_until: null,
        },
      },
    })

    await pollMailbox(db, MAILBOX, { now: NOW, deps })

    expect(calls[0].body.TextBody).toBe('the plain text')
    expect(calls[0].body.HtmlBody).toBe('<p>the html</p>')
    // The ordering itself, not just the outcome: both parts are on the wire
    // before the POST happens.
    expect(timeline.indexOf(['download', '11', '1'].join())).toBeLessThan(timeline.indexOf('POST'))
    const order = timeline.map(t => (Array.isArray(t) ? t[0] : t))
    expect(order.filter(o => o === 'download' || o === 'POST')).toEqual(['download', 'download', 'POST'])
  })

  it('🔴 a body that will not download is NOT filed as a blank ticket — the watermark is held', async () => {
    // IMAP-BLANKBODY.1, and it is silent PERMANENT data loss, not a cosmetic
    // gap. downloadBodyPart() swallows every error and returns null, so
    // nothing throws: the mapper emits TextBody '', the route files it,
    // answers 200 and the cursor advances past it. It can never be repaired —
    // the synthetic MessageID is deterministic, so a re-POST comes back
    // `200 deduped` and the body is never back-filled. One dropped socket
    // mid-backlog files a tick's worth of member emails as empty tickets.
    //
    // Holding the tick costs five minutes and loses nothing: the watermark
    // does not move, so the next tick downloads the same message again.
    const { fn } = stubFetch({})
    const { deps } = fakeImap({
      uidNext: 13,
      messages: [plainMessage(11), plainMessage(12)],
      bodies: { '11:1': new Error('BAD part not found'), '12:1': 'b' },
    })
    const db = makeDb({
      credentials: { [MAILBOX.id]: credential() },
      ingress: {
        [`${MAILBOX.id}:inbox`]: {
          mailbox_id: MAILBOX.id, folder: 'inbox', uidvalidity: 12345, last_uid: 10,
          consecutive_failures: 0, paused_until: null,
        },
      },
    })

    const out = await pollMailbox(db, MAILBOX, { now: NOW, deps })

    expect(out).toMatchObject({ ok: false, ingested: 0, reason: 'forward_failed' })
    // Nothing was POSTed at all — not the bodyless message, and not the one
    // behind it, which would have had to jump the cursor over it.
    expect(fn).not.toHaveBeenCalled()
    expect(db.state.ingress.get(`${MAILBOX.id}:inbox`).last_uid).toBe(10)
    expect(lastCursor(db).last_ok_at).toBeUndefined()
  })

  it('files a message whose text downloaded but whose html did not — one half is a real ticket', async () => {
    // The rule is "every body part we ATTEMPTED failed", not "any failed". A
    // ticket with its plain text is one an operator can answer, and the route
    // derives nothing from HTML it was not given; holding the mailbox for it
    // would trade a complete outcome for a delayed one at no gain.
    const { calls } = stubFetch({})
    const { deps } = fakeImap({
      uidNext: 12,
      messages: [alternativeMessage(11)],
      bodies: { '11:1': 'the plain text', '11:2': new Error('BAD part not found') },
    })
    const db = makeDb({
      credentials: { [MAILBOX.id]: credential() },
      ingress: {
        [`${MAILBOX.id}:inbox`]: {
          mailbox_id: MAILBOX.id, folder: 'inbox', uidvalidity: 12345, last_uid: 10,
          consecutive_failures: 0,
        },
      },
    })

    const out = await pollMailbox(db, MAILBOX, { now: NOW, deps })

    expect(out.ingested).toBe(1)
    expect(calls[0].body.TextBody).toBe('the plain text')
    expect(calls[0].body.HtmlBody).toBeNull()
    expect(lastCursor(db).last_uid).toBe(11)
  })

  it('🔴 a body that fails FOREVER still files eventually — a held watermark must have a floor', async () => {
    // The other half of IMAP-BLANKBODY.1. Holding on a TRANSIENT failure is
    // right; holding on a permanent one is the denial-of-inbox this file
    // spends its length avoiding, because no message behind it would ever be
    // ingested again. Past MAX_STALL_TICKS the message files with an empty
    // body and a loud error — a poor ticket beats no mail, ever.
    const { calls } = stubFetch({})
    const { deps } = fakeImap({
      uidNext: 12,
      messages: [plainMessage(11)],
      bodies: { '11:1': new Error('BAD part not found') },
    })
    const db = makeDb({
      credentials: { [MAILBOX.id]: credential() },
      ingress: {
        [`${MAILBOX.id}:inbox`]: {
          mailbox_id: MAILBOX.id, folder: 'inbox', uidvalidity: 12345, last_uid: 10,
          consecutive_failures: 12, paused_until: null,
        },
      },
    })

    const out = await pollMailbox(db, MAILBOX, { now: NOW, deps })

    expect(out.ingested).toBe(1)
    expect(calls[0].body.TextBody).toBe('')
    expect(calls[0].body.Subject).toBe('Hello')
    expect(lastCursor(db).last_uid).toBe(11)
  })

  it('a message with NO body part at all is logged rather than filed in silence', async () => {
    // An attachments-only email is legitimate, so this is not a failure — but
    // the ticket WILL look empty to whoever opens it, and "no log line at all"
    // is how that becomes an unexplainable support question.
    const { calls } = stubFetch({})
    const attachmentsOnly = plainMessage(11)
    attachmentsOnly.bodyStructure = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'application/pdf', disposition: 'attachment', dispositionParameters: { filename: 'invoice.pdf' }, size: 10 },
      ],
    }
    const { deps } = fakeImap({ uidNext: 12, messages: [attachmentsOnly] })
    const db = makeDb({
      credentials: { [MAILBOX.id]: credential() },
      ingress: {
        [`${MAILBOX.id}:inbox`]: {
          mailbox_id: MAILBOX.id, folder: 'inbox', uidvalidity: 12345, last_uid: 10,
          consecutive_failures: 0,
        },
      },
    })

    const out = await pollMailbox(db, MAILBOX, { now: NOW, deps })

    expect(out.ingested).toBe(1)
    expect(calls[0].body.TextBody).toBe('')
    expect(logWarn).toHaveBeenCalledWith(
      'imap-poll',
      expect.stringContaining('no text or html body part'),
      expect.objectContaining({ uid: 11 }),
    )
  })

  it('selectBodyParts never reads an attachment or a forwarded message as the body', () => {
    // A .txt attachment is text/plain. So is the body of a forwarded .eml.
    // Reading either as THE body puts the wrong words on the ticket.
    const structure = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', encoding: '7bit', size: 10 },
        { part: '2', type: 'text/plain', disposition: 'attachment', dispositionParameters: { filename: 'notes.txt' } },
        {
          part: '3',
          type: 'message/rfc822',
          childNodes: [{ part: '3.1', type: 'text/html', size: 99 }],
        },
      ],
    }
    expect(selectBodyParts(structure)).toEqual({ text: { part: '1' }, html: null })
  })

  it('selectBodyParts numbers a single-part message “1”, which is what RFC 3501 calls it', () => {
    expect(selectBodyParts({ type: 'text/html', size: 40 })).toEqual({ text: null, html: { part: '1' } })
  })
})

/* ═══════════════════ 5. per-message and per-mailbox isolation ═════════ */

describe('isolation', () => {
  it('🔴 one unparseable message does not stall the mailbox', async () => {
    // The message in the middle has a bodyStructure the walker chokes on and
    // no envelope at all. It must be logged, stepped over, and the two around
    // it must still file.
    const poison = plainMessage(12)
    poison.envelope = null
    Object.defineProperty(poison, 'bodyStructure', {
      get() { throw new Error('unreadable bodyStructure') },
    })

    const { fn } = stubFetch({ status: 200 })
    const { deps } = fakeImap({
      uidNext: 14,
      messages: [plainMessage(11), poison, plainMessage(13)],
      bodies: { '11:1': 'a', '13:1': 'c' },
    })
    const db = makeDb({
      credentials: { [MAILBOX.id]: credential() },
      ingress: {
        [`${MAILBOX.id}:inbox`]: {
          mailbox_id: MAILBOX.id, folder: 'inbox', uidvalidity: 12345, last_uid: 10,
          consecutive_failures: 0, paused_until: null,
        },
      },
    })

    const out = await pollMailbox(db, MAILBOX, { now: NOW, deps })

    expect(out.ok).toBe(true)
    expect(out.ingested + out.skipped).toBe(3)
    expect(fn).toHaveBeenCalledTimes(out.ingested)
    // The whole batch is behind the mailbox now — nothing is stuck at uid 12.
    expect(lastCursor(db).last_uid).toBe(13)
  })

  it('🔴 one mailbox failing auth does not stop another from ingesting', async () => {
    // 11.2, early. This is the test that says it is a platform rather than a
    // one-off: two tenants, one revoked app password, and the other tenant's
    // mail still arrives in the same tick.
    stubFetch({ status: 200 })

    const broken = fakeImap({ failAt: 'auth' })
    const working = fakeImap({
      uidNext: 12, messages: [plainMessage(11)], bodies: { '11:1': 'a' },
    })

    const db = makeDb({
      mailboxes: [MAILBOX, OTHER_MAILBOX],
      credentials: {
        [MAILBOX.id]: credential(),
        [OTHER_MAILBOX.id]: credential({ mailbox_id: OTHER_MAILBOX.id, username: 'stillorgan@un1t.com' }),
      },
      ingress: {
        [`${MAILBOX.id}:inbox`]: {
          mailbox_id: MAILBOX.id, folder: 'inbox', uidvalidity: 12345, last_uid: 10,
          consecutive_failures: 0, paused_until: null, last_run_at: '2026-08-26T11:50:00.000Z',
        },
        [`${OTHER_MAILBOX.id}:inbox`]: {
          mailbox_id: OTHER_MAILBOX.id, folder: 'inbox', uidvalidity: 12345, last_uid: 10,
          consecutive_failures: 0, paused_until: null, last_run_at: '2026-08-26T11:55:00.000Z',
        },
      },
    })

    const out = await pollAllMailboxes(db, {
      now: NOW,
      concurrency: 2,
      // 🔴 One lane, because this test is about TENANT isolation and a
      // two-lane sweep would double every count in it for reasons that have
      // nothing to do with what it pins. The lane loop has its own tests.
      lanes: ['inbox'],
      // One client per mailbox: the broken one for MAILBOX, the working one
      // for OTHER_MAILBOX. createClient sees the options, which carry the
      // username, so the fake can route on it.
      deps: {
        createClient: (opts) => (opts.auth.user === 'hatchstreet@un1t.com' ? broken.client : working.client),
      },
    })

    expect(out).toMatchObject({ mailboxes: 2, ingested: 1, failed: 1, ok: true })
    // The broken tenant is recorded and backed off…
    expect(db.state.ingress.get(`${MAILBOX.id}:inbox`).consecutive_failures).toBe(1)
    // MAILBOX-CONNECT.8 — the CATEGORY, not the server's words. `last_error`
    // renders on a settings card a customer-tier owner can read, so echoing
    // err.responseText there makes the poller a slower version of the SSRF
    // oracle the connect route closed. The detail still reaches the log.
    expect(db.state.ingress.get(`${MAILBOX.id}:inbox`).last_error).toMatch(/app password/i)
    expect(db.state.ingress.get(`${MAILBOX.id}:inbox`).last_error).not.toMatch(/Invalid credentials/)
    // …while the healthy tenant's watermark moved.
    expect(db.state.ingress.get(`${OTHER_MAILBOX.id}:inbox`).last_uid).toBe(11)
  })

  it('polls the least-recently-run mailbox first, and a never-run one before that', async () => {
    stubFetch({ status: 200 })
    const seen = []
    const db = makeDb({
      mailboxes: [MAILBOX, OTHER_MAILBOX],
      credentials: {
        [MAILBOX.id]: credential(),
        [OTHER_MAILBOX.id]: credential({ mailbox_id: OTHER_MAILBOX.id, username: 'stillorgan@un1t.com' }),
      },
      ingress: {
        // MAILBOX ran a minute ago; OTHER_MAILBOX has never run at all.
        [`${MAILBOX.id}:inbox`]: {
          mailbox_id: MAILBOX.id, folder: 'inbox', uidvalidity: 12345, last_uid: 10,
          consecutive_failures: 0, last_run_at: '2026-08-26T11:59:00.000Z',
        },
      },
    })

    await pollAllMailboxes(db, {
      now: NOW,
      concurrency: 1,
      // One lane: `seen` is an ORDER assertion, and a second lane would append
      // its own pass to the same array.
      lanes: ['inbox'],
      deps: {
        createClient: (opts) => {
          seen.push(opts.auth.user)
          return fakeImap({ uidNext: 11, messages: [] }).client
        },
      },
    })

    expect(seen).toEqual(['stillorgan@un1t.com', 'hatchstreet@un1t.com'])
  })

  it('a sweep with nothing connected is a healthy, dormant tick', async () => {
    // The `lanes` breakdown is seeded even here, and deliberately: a key that
    // appears only on a busy tick is a key nothing can chart, and this shape
    // rides into cron_heartbeats.last_outcome.
    const db = makeDb({ mailboxes: [] })
    const zero = { ingested: 0, skipped: 0, failed: 0, paused: 0, unconfigured: 0 }
    await expect(pollAllMailboxes(db, { now: NOW })).resolves.toEqual({
      ok: true, mailboxes: 0, ingested: 0, skipped: 0, failed: 0, paused: 0,
      lanes: { inbox: { ...zero }, sent: { ...zero } },
    })
  })

  it('a sweep that cannot read its own mailbox list reports ok:false', async () => {
    const db = makeDb({ mailboxes: [MAILBOX], errors: { mailboxes: { message: 'PostgREST down' } } })
    const out = await pollAllMailboxes(db, { now: NOW })
    expect(out).toMatchObject({ ok: false, reason: 'mailbox_lookup_failed' })
  })
})

/* ══════════════ 5b. last_error is not a response oracle ══════════════ */

// MAILBOX-CONNECT.8. The connect-verify route was hardened to classify dial
// failures rather than echo the remote server's bytes, because an operator can
// point it at any host and read the answer. The poller re-dials that same
// stored host every five minutes and writes the result to the SAME settings
// card — so leaving the raw text here would just make it the slower way to ask
// the identical question, and the one route-level residual that could not be
// closed (a name that resolves publicly once and internally later) surfaces
// exactly here.
describe('last_error never carries the remote server’s words', () => {
  const dialWorld = (failAt) => {
    const { deps } = fakeImap({ failAt })
    const db = makeDb({
      credentials: { [MAILBOX.id]: credential() },
      ingress: {
        [`${MAILBOX.id}:inbox`]: {
          mailbox_id: MAILBOX.id, folder: 'inbox', uidvalidity: 12345, last_uid: 10,
          consecutive_failures: 0, paused_until: null,
        },
      },
    })
    return { db, deps }
  }

  it('reports a category for a transport failure, not the banner', async () => {
    const { db, deps } = dialWorld('connect')
    await pollMailbox(db, MAILBOX, { now: NOW, deps })
    const stored = lastCursor(db).last_error
    // Nothing identifying the target survives: not the errno, not the host,
    // not the port. Those are the three things a probe would read.
    expect(stored).not.toMatch(/ECONNREFUSED/)
    expect(stored).not.toMatch(/imap\.gmail\.com/)
    expect(stored).not.toMatch(/993/)
    // …and it is still worth reading.
    expect(stored).toMatch(/Could not reach the mail server/i)
  })

  it('reports a category for an auth failure, not the server’s rejection', async () => {
    const { db, deps } = dialWorld('auth')
    await pollMailbox(db, MAILBOX, { now: NOW, deps })
    const stored = lastCursor(db).last_error
    expect(stored).not.toMatch(/Invalid credentials/)
    expect(stored).not.toMatch(/Failure/)
    // The category has to stay distinguishable from the transport one: the
    // fixes differ, and collapsing them would cost the operator the diagnosis.
    expect(stored).toMatch(/app password/i)
    expect(stored).not.toMatch(/Could not reach the mail server/i)
  })

  it('still writes the detail somewhere an engineer can find it', async () => {
    // Redaction that DELETES the diagnosis is not a fix, it is a different
    // failure — the estate's rule is never to trade a silent failure for a
    // louder one. The bytes move to the log; they do not vanish.
    const { db, deps } = dialWorld('connect')
    await pollMailbox(db, MAILBOX, { now: NOW, deps })
    // logError is the sink (it is mocked at the top of this file). The raw
    // text must be in there even though it is not on the card.
    expect(JSON.stringify(logError.mock.calls)).toMatch(/ECONNREFUSED/)
    // And the credential redaction still applies to the log copy — moving the
    // text to a different sink must not move it out of safeErrorText's reach.
    expect(JSON.stringify(logError.mock.calls)).not.toMatch(/app-specific-secret/)
  })
})

/* ═══════════════════════════ 6. backoff ═══════════════════════════════ */

describe('backoff', () => {
  it('🔴 increments the failure count, and pauses from the SECOND failure', async () => {
    const { deps } = fakeImap({ failAt: 'connect' })
    const db = makeDb({
      credentials: { [MAILBOX.id]: credential() },
      ingress: {
        [`${MAILBOX.id}:inbox`]: {
          mailbox_id: MAILBOX.id, folder: 'inbox', uidvalidity: 12345, last_uid: 10,
          consecutive_failures: 0, paused_until: null,
        },
      },
    })

    const first = await pollMailbox(db, MAILBOX, { now: NOW, deps })
    expect(first).toMatchObject({ ok: false, reason: 'connect_failed' })
    expect(lastCursor(db).consecutive_failures).toBe(1)
    // A single blip retries on the next tick rather than parking the mailbox.
    expect(lastCursor(db).paused_until).toBeNull()
    // The operator gets something actionable; the remote end's own bytes stay
    // out of a screen they can read. See the auth case above.
    expect(lastCursor(db).last_error).toMatch(/Could not reach the mail server/i)
    expect(lastCursor(db).last_error).not.toMatch(/ECONNREFUSED/)

    const second = await pollMailbox(db, MAILBOX, { now: NOW, deps })
    expect(second.ok).toBe(false)
    expect(lastCursor(db).consecutive_failures).toBe(2)
    expect(Date.parse(lastCursor(db).paused_until)).toBe(NOW + 10 * 60_000)
  })

  it('a paused mailbox is skipped without opening a connection', async () => {
    let created = false
    const db = makeDb({
      credentials: { [MAILBOX.id]: credential() },
      ingress: {
        [`${MAILBOX.id}:inbox`]: {
          mailbox_id: MAILBOX.id, folder: 'inbox', uidvalidity: 12345, last_uid: 10,
          consecutive_failures: 4, paused_until: new Date(NOW + 60_000).toISOString(),
        },
      },
    })

    const out = await pollMailbox(db, MAILBOX, {
      now: NOW,
      deps: { createClient: () => { created = true; return fakeImap().client } },
    })

    expect(out).toEqual({ ok: true, ingested: 0, skipped: 0, reason: 'paused' })
    expect(created).toBe(false)
    expect(db.state.upserts).toHaveLength(0)
  })

  it('an auth failure backs off harder than a transport failure — it needs a person', () => {
    // §9.3. A revoked app password is an operator action, not an outage, and
    // retrying it every five minutes for a day helps nobody.
    expect(backoffMs('transport', 1)).toBe(0)
    expect(backoffMs('auth', 1)).toBe(0)
    expect(backoffMs('transport', 2)).toBe(10 * 60_000)
    expect(backoffMs('auth', 2)).toBe(30 * 60_000)
    expect(backoffMs('transport', 3)).toBe(20 * 60_000)
    expect(backoffMs('transport', 99)).toBe(2 * 60 * 60_000)
    expect(backoffMs('auth', 99)).toBe(24 * 60 * 60_000)
  })

  it('classifies an imapflow authentication failure distinctly from a dead socket', () => {
    const authErr = Object.assign(new Error('Invalid credentials'), { authenticationFailed: true })
    expect(classifyImapFailure(authErr)).toBe('auth')
    expect(classifyImapFailure({ serverResponseCode: 'AUTHENTICATIONFAILED' })).toBe('auth')
    expect(classifyImapFailure(new Error('Application-specific password required'))).toBe('auth')
    expect(classifyImapFailure(new Error('ETIMEDOUT'))).toBe('transport')
  })

  it('a mailbox with no stored credential is an operator problem, recorded and backed off', async () => {
    const db = makeDb({ credentials: {} })
    const out = await pollMailbox(db, MAILBOX, { now: NOW, deps: { createClient: () => fakeImap().client } })
    expect(out).toMatchObject({ ok: false, reason: 'not_configured' })
    expect(lastCursor(db).consecutive_failures).toBe(1)
  })

  it('🔴 an unreadable cursor row stops the poll — it never guesses the watermark', async () => {
    // "No row" means cold start. "Could not read the row" means the watermark
    // is unknown, and polling on an unknown watermark is how a mailbox gets
    // re-ingested from UID 1.
    let created = false
    const db = makeDb({
      credentials: { [MAILBOX.id]: credential() },
      errors: { cursor: { message: 'statement timeout' } },
    })
    const out = await pollMailbox(db, MAILBOX, {
      now: NOW,
      deps: { createClient: () => { created = true; return fakeImap().client } },
    })
    expect(out).toMatchObject({ ok: false, reason: 'cursor_lookup_failed' })
    expect(created).toBe(false)
  })
})

/* ══════════════════════ 7. the forward target ═════════════════════════ */

describe('the forward target', () => {
  it('is resolved before anything is opened, and a missing token pauses nothing', async () => {
    // Every mailbox in the estate hits this at the same moment. Pausing them
    // all for a day because an env var was missing for ten minutes is the
    // silent stop this feature exists to avoid.
    delete process.env.POSTMARK_EMAIL_INBOX_WEBHOOK_TOKEN
    let created = false
    const db = makeDb({ credentials: { [MAILBOX.id]: credential() } })

    const out = await pollMailbox(db, MAILBOX, {
      now: NOW,
      deps: { createClient: () => { created = true; return fakeImap().client } },
    })

    expect(out).toMatchObject({ ok: false, reason: 'not_configured' })
    expect(created).toBe(false)
    expect(lastCursor(db).consecutive_failures).toBeUndefined()
    expect(lastCursor(db).paused_until).toBeUndefined()
    expect(lastCursor(db).last_error).toMatch(/POSTMARK_EMAIL_INBOX_WEBHOOK_TOKEN/)
  })

  it('falls back to this deployment’s own origin when CRM_WEBHOOK_BASE_URL is unset', () => {
    delete process.env.CRM_WEBHOOK_BASE_URL
    process.env.NEXT_PUBLIC_APP_URL = 'https://crm.repset.ie/'
    const target = resolveInboundTarget()
    expect(target.url).toBe('https://crm.repset.ie/api/webhooks/postmark-inbound/inbound-token-abc')
    // 🔴 The token is never logged.
    expect(target.loggable).toBe('https://crm.repset.ie/api/webhooks/postmark-inbound/<token>')
  })

  it('marks the hop with a header that carries no authority', async () => {
    const { calls } = stubFetch({})
    const { deps } = fakeImap({
      uidNext: 12, messages: [plainMessage(11)], bodies: { '11:1': 'a' },
    })
    const db = makeDb({
      credentials: { [MAILBOX.id]: credential() },
      ingress: {
        [`${MAILBOX.id}:inbox`]: {
          mailbox_id: MAILBOX.id, folder: 'inbox', uidvalidity: 12345, last_uid: 10,
          consecutive_failures: 0,
        },
      },
    })

    await pollMailbox(db, MAILBOX, { now: NOW, deps })

    expect(calls[0].headers['x-un1t-producer']).toBe('imap-poll')
    expect(calls[0].headers['content-type']).toBe('application/json')
  })
})

/* ════════ 8. the cross-tenant guard (IMAP-ROUTE-FORGE.1) ══════════════ */

describe('a message files into the mailbox that RECEIVED it', () => {
  const seededCursor = (mailbox) => ({
    mailbox_id: mailbox.id, folder: 'inbox', uidvalidity: 12345, last_uid: 10,
    consecutive_failures: 0, paused_until: null,
  })

  /** A message whose visible To: names a DIFFERENT connected studio. */
  function forgedMessage(uid) {
    const msg = plainMessage(uid)
    msg.envelope.to = [{ name: null, address: OTHER_MAILBOX.address }]
    return msg
  }

  it('🔴 a forged To: naming another studio is stripped before the payload leaves', async () => {
    // The cross-tenant defect, end to end through the real poller. Without the
    // strip, recipientEmails' ToFull → CcFull → To → OriginalRecipient
    // precedence hands this message to Stillorgan: their location, their
    // contacts, their staff, their attachment quota — and Hatch Street, the
    // mailbox it was actually delivered to, never sees it, because the POST
    // answers 2xx and the watermark advances.
    const { calls } = stubFetch({ status: 200 })
    const { deps } = fakeImap({
      uidNext: 12, messages: [forgedMessage(11)], bodies: { '11:1': 'a' },
    })
    const db = makeDb({
      mailboxes: [MAILBOX, OTHER_MAILBOX],
      credentials: { [MAILBOX.id]: credential() },
      ingress: { [`${MAILBOX.id}:inbox`]: seededCursor(MAILBOX) },
    })

    await pollMailbox(db, MAILBOX, { now: NOW, deps })

    const payload = calls[0].body
    expect(payload.ToFull).toEqual([])
    expect(payload.To).toBe('')
    expect(payload.OriginalRecipient).toBe(MAILBOX.address)
    // Nothing anywhere on the payload still names the other studio.
    expect(JSON.stringify(payload)).not.toContain(OTHER_MAILBOX.address)
  })

  it('keeps a real third-party recipient — the strip is OUR addresses, not every address', async () => {
    const { calls } = stubFetch({ status: 200 })
    const msg = plainMessage(11)
    msg.envelope.to = [
      { name: null, address: MAILBOX.address },
      { name: null, address: OTHER_MAILBOX.address },
      { name: null, address: 'member@example.com' },
    ]
    const { deps } = fakeImap({ uidNext: 12, messages: [msg], bodies: { '11:1': 'a' } })
    const db = makeDb({
      mailboxes: [MAILBOX, OTHER_MAILBOX],
      credentials: { [MAILBOX.id]: credential() },
      ingress: { [`${MAILBOX.id}:inbox`]: seededCursor(MAILBOX) },
    })

    await pollMailbox(db, MAILBOX, { now: NOW, deps })

    expect(calls[0].body.ToFull.map(r => r.Email)).toEqual([MAILBOX.address, 'member@example.com'])
  })

  it('🔴 two connected mailboxes on one thread each file THEIR OWN copy', async () => {
    // The double-filing half. `To: hatchstreet@, Cc: stillorgan@` used to make
    // the Stillorgan poll resolve HATCH STREET, so Hatch got two tickets and
    // Stillorgan got none — and mailbox visibility is grant-gated, so a coach
    // granted only Stillorgan never saw their own correspondence.
    const { calls } = stubFetch({ status: 200 })
    const both = (uid) => {
      const msg = plainMessage(uid)
      msg.envelope.to = [{ name: null, address: MAILBOX.address }]
      msg.envelope.cc = [{ name: null, address: OTHER_MAILBOX.address }]
      return msg
    }
    const db = makeDb({
      mailboxes: [MAILBOX, OTHER_MAILBOX],
      credentials: {
        [MAILBOX.id]: credential(),
        [OTHER_MAILBOX.id]: credential({ mailbox_id: OTHER_MAILBOX.id, username: OTHER_MAILBOX.address }),
      },
      ingress: {
        [`${MAILBOX.id}:inbox`]: seededCursor(MAILBOX),
        [`${OTHER_MAILBOX.id}:inbox`]: seededCursor(OTHER_MAILBOX),
      },
    })

    await pollAllMailboxes(db, {
      now: NOW,
      concurrency: 1,
      deps: {
        createClient: () => fakeImap({
          uidNext: 12, messages: [both(11)], bodies: { '11:1': 'a' },
        }).client,
      },
    })

    expect(calls).toHaveLength(2)
    const byRecipient = Object.fromEntries(calls.map(c => [c.body.OriginalRecipient, c.body]))
    // Each copy resolves to itself and mentions no other connected mailbox.
    expect(byRecipient[MAILBOX.address].ToFull.map(r => r.Email)).toEqual([MAILBOX.address])
    expect(byRecipient[MAILBOX.address].CcFull).toEqual([])
    expect(byRecipient[OTHER_MAILBOX.address].ToFull).toEqual([])
    expect(byRecipient[OTHER_MAILBOX.address].CcFull.map(r => r.Email)).toEqual([OTHER_MAILBOX.address])
    // Two mailboxes on one email is two tickets by design — the synthetic
    // MessageID folds mailboxId into the digest for exactly this.
    expect(byRecipient[MAILBOX.address].MessageID)
      .not.toBe(byRecipient[OTHER_MAILBOX.address].MessageID)
  })

  it('🔴 FAILS CLOSED: an unreadable address list refuses the poll rather than risking a misfile', async () => {
    // Filing a member's email into another tenant's inbox is irreversible and
    // cross-tenant. Refusing costs one tick, because the watermark does not
    // move and the next tick re-reads the same messages.
    const { fn } = stubFetch({ status: 200 })
    let created = false
    const db = makeDb({
      mailboxes: [MAILBOX],
      credentials: { [MAILBOX.id]: credential() },
      ingress: { [`${MAILBOX.id}:inbox`]: seededCursor(MAILBOX) },
      errors: { addresses: { message: 'statement timeout' } },
    })

    const out = await pollMailbox(db, MAILBOX, {
      now: NOW,
      deps: { createClient: () => { created = true; return fakeImap().client } },
    })

    expect(out).toMatchObject({ ok: false, reason: 'address_set_unavailable' })
    expect(created).toBe(false)
    expect(fn).not.toHaveBeenCalled()
    expect(db.state.ingress.get(`${MAILBOX.id}:inbox`).last_uid).toBe(10)
    // …and it is a DEPLOYMENT fault, so it neither counts nor pauses: it hits
    // every tenant at once.
    expect(lastCursor(db).consecutive_failures).toBeUndefined()
    expect(lastCursor(db).paused_until).toBeUndefined()
    expect(lastCursor(db).last_error).toMatch(/mailbox addresses/i)
  })

  it('reads the estate address list ONCE for the whole sweep, not once per mailbox', async () => {
    stubFetch({ status: 200 })
    const db = makeDb({
      mailboxes: [MAILBOX, OTHER_MAILBOX],
      credentials: {
        [MAILBOX.id]: credential(),
        [OTHER_MAILBOX.id]: credential({ mailbox_id: OTHER_MAILBOX.id, username: OTHER_MAILBOX.address }),
      },
    })

    await pollAllMailboxes(db, {
      now: NOW,
      concurrency: 2,
      deps: { createClient: () => fakeImap({ uidNext: 11, messages: [] }).client },
    })

    expect(db.state.reads.filter(r => r === 'addresses')).toHaveLength(1)
  })
})

/* ═══════ 9. the forward budget and the stall floor ═══════════════════ */

describe('a message that cannot be forwarded never stalls the mailbox forever', () => {
  const seededCursor = (failures = 0) => ({
    mailbox_id: MAILBOX.id, folder: 'inbox', uidvalidity: 12345, last_uid: 10,
    consecutive_failures: failures, paused_until: null,
  })

  it('🔴 a 413 is a PERMANENT rejection, not a retry — it is what killed the mailbox', async () => {
    // Vercel answers a body over ~4.5 MB with a plain-text 413 raised BEFORE
    // the route runs. It is neither a 2xx nor the route's own 400, so it used
    // to take the "halt and retry" branch — and the payload is deterministic,
    // so the mailbox retried the same message every tick and ingested nothing
    // else ever again, with a green heartbeat throughout.
    const { fn } = stubFetch({ statuses: [413, 200] })
    const { deps } = fakeImap({
      uidNext: 13,
      messages: [plainMessage(11), plainMessage(12)],
      bodies: { '11:1': 'a', '12:1': 'b' },
    })
    const db = makeDb({
      credentials: { [MAILBOX.id]: credential() },
      ingress: { [`${MAILBOX.id}:inbox`]: seededCursor() },
    })

    const out = await pollMailbox(db, MAILBOX, { now: NOW, deps })

    expect(out).toMatchObject({ ok: true, ingested: 1, skipped: 1 })
    expect(fn).toHaveBeenCalledTimes(2)
    expect(lastCursor(db).last_uid).toBe(12)
    expect(logError).toHaveBeenCalledWith(
      'imap-poll',
      expect.stringContaining('permanently refused'),
      expect.objectContaining({ uid: 11, status: 413 }),
    )
  })

  it('🔴 401/403/404/429 still HALT — a wrong token is wrong for every message', async () => {
    // The counter-case that keeps the permanent list narrow. Stepping over
    // these would drain a whole mailbox into nothing on one bad env var.
    for (const status of [401, 403, 404, 429]) {
      vi.clearAllMocks()
      const { deps } = fakeImap({
        uidNext: 12, messages: [plainMessage(11)], bodies: { '11:1': 'a' },
      })
      stubFetch({ status })
      const db = makeDb({
        credentials: { [MAILBOX.id]: credential() },
        ingress: { [`${MAILBOX.id}:inbox`]: seededCursor() },
      })

      const out = await pollMailbox(db, MAILBOX, { now: NOW, deps })

      expect(out).toMatchObject({ ok: false, reason: 'forward_failed' })
      expect(db.state.ingress.get(`${MAILBOX.id}:inbox`).last_uid).toBe(10)
    }
  })

  it('🔴 a long-stalled mailbox DEAD-LETTERS the blocker once the route proves it is healthy', async () => {
    // The floor under "halt and retry". After MAX_STALL_TICKS of zero progress
    // the poller holds the refused message back and probes the next one; the
    // probe's 2xx is what proves this is a poison message rather than an
    // outage, and only then is the blocker stepped over.
    const { calls } = stubFetch({ statuses: [500, 200, 200] })
    const { deps } = fakeImap({
      uidNext: 14,
      messages: [plainMessage(11), plainMessage(12), plainMessage(13)],
      bodies: { '11:1': 'a', '12:1': 'b', '13:1': 'c' },
    })
    const db = makeDb({
      credentials: { [MAILBOX.id]: credential() },
      ingress: { [`${MAILBOX.id}:inbox`]: seededCursor(12) },
    })

    const out = await pollMailbox(db, MAILBOX, { now: NOW, deps })

    expect(out).toMatchObject({ ok: true, ingested: 2, skipped: 1 })
    expect(calls).toHaveLength(3)
    // The mailbox is unblocked: 12 and 13 filed, and the watermark cleared 11.
    expect(lastCursor(db).last_uid).toBe(13)
    expect(logError).toHaveBeenCalledWith(
      'imap-poll',
      expect.stringContaining('DEAD-LETTERED'),
      expect.objectContaining({ uid: 11, status: 500 }),
    )
  })

  it('🔴 …but an OUTAGE loses nothing: with no proof, the watermark does not move', async () => {
    // The half that makes the escape safe. "Step over after N tries" would
    // bleed one real message per mailbox per tick through a long outage —
    // trading a visible stall for silent loss, which is the worse of the two.
    const { calls } = stubFetch({ status: 500 })
    const { deps } = fakeImap({
      uidNext: 14,
      messages: [plainMessage(11), plainMessage(12), plainMessage(13)],
      bodies: { '11:1': 'a', '12:1': 'b', '13:1': 'c' },
    })
    const db = makeDb({
      credentials: { [MAILBOX.id]: credential() },
      ingress: { [`${MAILBOX.id}:inbox`]: seededCursor(12) },
    })

    const out = await pollMailbox(db, MAILBOX, { now: NOW, deps })

    expect(out).toMatchObject({ ok: false, ingested: 0, skipped: 0, reason: 'forward_failed' })
    // Exactly one probe, then it stops. Nothing is stepped over.
    expect(calls).toHaveLength(2)
    expect(db.state.ingress.get(`${MAILBOX.id}:inbox`).last_uid).toBe(10)
    expect(logError).not.toHaveBeenCalledWith(
      'imap-poll', expect.stringContaining('DEAD-LETTERED'), expect.anything(),
    )
  })

  it('a HEALTHY mailbox never defers — one 5xx halts on the spot, as it always did', async () => {
    const { calls } = stubFetch({ status: 500 })
    const { deps } = fakeImap({
      uidNext: 13,
      messages: [plainMessage(11), plainMessage(12)],
      bodies: { '11:1': 'a', '12:1': 'b' },
    })
    const db = makeDb({
      credentials: { [MAILBOX.id]: credential() },
      ingress: { [`${MAILBOX.id}:inbox`]: seededCursor(0) },
    })

    await pollMailbox(db, MAILBOX, { now: NOW, deps })

    expect(calls).toHaveLength(1)
  })

  it('🔴 a payload over the forward budget is TRIMMED, never sent to be 413ed', async () => {
    // The measurement, not the per-field caps: a body that is mostly control
    // bytes inflates ~6x through JSON.stringify, so a payload well inside the
    // character caps can still be megabytes on the wire.
    const { calls } = stubFetch({ status: 200 })
    // U+0001 is ONE byte in UTF-8 and SIX in JSON (\u0001), which is the whole
    // point: 600k characters of it sits inside every character cap this module
    // has and is still 3.6 MB on the wire.
    const control = '\u0001'.repeat(900_000)
    const { deps } = fakeImap({
      uidNext: 12,
      messages: [alternativeMessage(11)],
      bodies: { '11:1': control, '11:2': control },
    })
    const db = makeDb({
      credentials: { [MAILBOX.id]: credential() },
      ingress: { [`${MAILBOX.id}:inbox`]: seededCursor() },
    })

    const out = await pollMailbox(db, MAILBOX, { now: NOW, deps })

    expect(out.ingested).toBe(1)
    expect(Buffer.byteLength(JSON.stringify(calls[0].body), 'utf8')).toBeLessThan(3_500_000)
    // Trimmed, not emptied — the ticket still carries what fits.
    expect(calls[0].body.TextBody.length).toBeGreaterThan(0)
    expect(logWarn).toHaveBeenCalledWith(
      'imap-poll', expect.stringContaining('forward budget'), expect.objectContaining({ uid: 11 }),
    )
  })

  it('enforceForwardBudget leaves an ordinary payload byte-identical', () => {
    const payload = { MessageID: 'imap-x', TextBody: 'hello', HtmlBody: null }
    expect(enforceForwardBudget(payload)).toEqual({
      ok: true, body: JSON.stringify(payload), trimmed: false,
    })
  })
})

/* ══════════ 10. staged attachment bytes are never orphaned ═══════════ */

describe('staged attachment bytes', () => {
  /** A message with one small attachment part alongside its text body. */
  function messageWithAttachment(uid) {
    const msg = plainMessage(uid)
    msg.bodyStructure = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', encoding: '7bit', size: 10 },
        {
          part: '2',
          type: 'application/pdf',
          encoding: 'base64',
          size: 12,
          disposition: 'attachment',
          dispositionParameters: { filename: 'invoice.pdf' },
        },
      ],
    }
    return msg
  }

  /** imapflow's downloadMany() shape, which is what the attachment path uses. */
  function withAttachmentDownload(imap) {
    imap.client.downloadMany = async () => ({ 2: { content: Buffer.from('%PDF-1.4') } })
    return imap
  }

  const seeded = {
    mailbox_id: MAILBOX.id, folder: 'inbox', uidvalidity: 12345, last_uid: 10,
    consecutive_failures: 0,
  }

  it('🔴 a permanently-refused message does not leave its bytes billing forever', async () => {
    // The route wraps every "nothing here will ever reference these bytes"
    // exit in discardStagedAttachments — but its 400s are raised in POST,
    // BEFORE that wrapper exists, so the producer owns the cleanup on this
    // path. Without it the objects sit in a metered bucket with nothing that
    // will ever name them.
    stubFetch({ status: 400 })
    const { deps } = withAttachmentDownload(fakeImap({
      uidNext: 12, messages: [messageWithAttachment(11)], bodies: { '11:1': 'a' },
    }))
    const db = makeDb({
      credentials: { [MAILBOX.id]: credential() },
      ingress: { [`${MAILBOX.id}:inbox`]: seeded },
    })

    const out = await pollMailbox(db, MAILBOX, { now: NOW, deps })

    expect(out.skipped).toBe(1)
    expect(db.state.uploads).toHaveLength(1)
    expect(db.state.removed).toEqual(db.state.uploads.map(u => u.path))
  })

  it('a message that WAS filed keeps its bytes — the route owns them from there', async () => {
    stubFetch({ status: 200 })
    const { deps } = withAttachmentDownload(fakeImap({
      uidNext: 12, messages: [messageWithAttachment(11)], bodies: { '11:1': 'a' },
    }))
    const db = makeDb({
      credentials: { [MAILBOX.id]: credential() },
      ingress: { [`${MAILBOX.id}:inbox`]: seeded },
    })

    await pollMailbox(db, MAILBOX, { now: NOW, deps })

    expect(db.state.uploads).toHaveLength(1)
    expect(db.state.removed).toEqual([])
  })

  it('a HALTED message keeps its bytes — the retry overwrites the same deterministic key', async () => {
    // Deliberately not swept: the next tick re-stages to the identical path,
    // so discarding here would only cost a re-upload, and the route's own
    // residue note makes the same call.
    stubFetch({ status: 500 })
    const { deps } = withAttachmentDownload(fakeImap({
      uidNext: 12, messages: [messageWithAttachment(11)], bodies: { '11:1': 'a' },
    }))
    const db = makeDb({
      credentials: { [MAILBOX.id]: credential() },
      ingress: { [`${MAILBOX.id}:inbox`]: seeded },
    })

    await pollMailbox(db, MAILBOX, { now: NOW, deps })

    expect(db.state.removed).toEqual([])
  })
})

/* ═══════ 11. config faults do not pause the estate ══════════════════ */

describe('a configuration fault is recorded, never counted and never paused', () => {
  it('🔴 a missing MAILBOX_SECRET_KEY does not put every tenant on the 30min→24h curve', async () => {
    // resolveAuth reports `not_configured` both for "this mailbox has no
    // credential" and for "this DEPLOYMENT has no encryption key". The second
    // hits every connected mailbox in the estate at the same instant, and
    // feeding it to the auth backoff paused all of them for up to a day over
    // an env var nobody set. The authors had already reasoned this out for the
    // inbound target thirty lines earlier in the same function.
    // Sealed while the key is still present — the row survives a key that
    // later goes missing, which is exactly the deployment fault being modelled.
    const db = makeDb({ credentials: { [MAILBOX.id]: credential() } })
    delete process.env.MAILBOX_SECRET_KEY
    let created = false

    const out = await pollMailbox(db, MAILBOX, {
      now: NOW,
      deps: { createClient: () => { created = true; return fakeImap().client } },
    })

    expect(out).toMatchObject({ ok: false, reason: 'not_configured' })
    expect(created).toBe(false)
    expect(lastCursor(db).consecutive_failures).toBeUndefined()
    expect(lastCursor(db).paused_until).toBeUndefined()
    expect(lastCursor(db).last_error).toMatch(/MAILBOX_SECRET_KEY/)
  })

  it('…while a mailbox with NO stored credential still counts — that one IS per-mailbox', async () => {
    // The distinction the fix rests on. Both are `not_configured`; only one is
    // a deployment fault, and it is told apart by asking secret-box rather than
    // by matching resolveAuth's sentence, which is theirs to reword.
    const db = makeDb({ credentials: {} })
    const out = await pollMailbox(db, MAILBOX, { now: NOW, deps: { createClient: () => fakeImap().client } })
    expect(out).toMatchObject({ ok: false, reason: 'not_configured' })
    expect(lastCursor(db).consecutive_failures).toBe(1)
  })

  it('🔴 a mailbox with no Sent folder is simply NOT SWEPT for sent — not a fault, not a row', async () => {
    // Phase 8B. A Sent folder is provider-specific and optional: the "other"
    // provider preset ships an empty box, so a mailbox whose operator never
    // named one is the ORDINARY state, not a broken mailbox. The sweep now
    // asks every connected mailbox for this lane every five minutes, so
    // recording it as a config fault would paint a healthy mailbox red on the
    // settings card forever and write a cursor row for a lane nobody asked
    // for.
    const db = makeDb({ credentials: { [MAILBOX.id]: credential({ sent_folder: null }) } })
    let created = false

    const out = await pollMailbox(db, MAILBOX, {
      now: NOW,
      folder: 'sent',
      deps: { createClient: () => { created = true; return fakeImap().client } },
    })

    expect(out).toMatchObject({ ok: true, ingested: 0, skipped: 0, reason: 'lane_not_configured' })
    // Nothing dialled, nothing written, nothing counted, nothing paused — and
    // no error log, because one line per mailbox per tick IS the noise.
    expect(created).toBe(false)
    expect(db.state.upserts).toHaveLength(0)
    expect(logError).not.toHaveBeenCalled()
  })

  it('a lane this module does not know IS a fault — recorded, not backed off', async () => {
    // The counter-case. An unresolvable lane that is not 'sent' can only be a
    // caller passing a name that does not exist, which is a bug worth seeing.
    const db = makeDb({ credentials: { [MAILBOX.id]: credential() } })

    const out = await pollMailbox(db, MAILBOX, {
      now: NOW, folder: 'drafts', deps: { createClient: () => fakeImap().client },
    })

    expect(out).toMatchObject({ ok: false, reason: 'no_folder' })
    const cursor = lastCursor(db, MAILBOX.id, 'drafts')
    expect(cursor.consecutive_failures).toBeUndefined()
    expect(cursor.paused_until).toBeUndefined()
    expect(cursor.last_error).toMatch(/No IMAP folder is configured/)
  })
})

/* ══════════ 12. the wall-clock budget ════════════════════════════════ */

describe('the tick budget', () => {
  /** A clock that jumps `stepMs` on every read, so a deadline is reachable. */
  function tickingClock(startAt, stepMs) {
    let t = startAt
    return () => { const v = t; t += stepMs; return v }
  }

  it('🔴 stops between messages once the budget is spent, and keeps what it earned', async () => {
    // 25 messages × a 30s forward timeout is 750s against a 300s maxDuration,
    // and a tenant controls their own mailbox contents. Without a deadline the
    // function is killed mid-sweep — every OTHER tenant loses its tick, and
    // the kill lands before the caller's stampHeartbeat(), so the poller
    // reports stale while behaving exactly as designed.
    const { calls } = stubFetch({ status: 200 })
    const { deps } = fakeImap({
      uidNext: 15,
      messages: [plainMessage(11), plainMessage(12), plainMessage(13), plainMessage(14)],
      bodies: { '11:1': 'a', '12:1': 'b', '13:1': 'c', '14:1': 'd' },
    })
    const db = makeDb({
      credentials: { [MAILBOX.id]: credential() },
      ingress: {
        [`${MAILBOX.id}:inbox`]: {
          mailbox_id: MAILBOX.id, folder: 'inbox', uidvalidity: 12345, last_uid: 10,
          consecutive_failures: 0,
        },
      },
    })

    const out = await pollMailbox(db, MAILBOX, {
      now: NOW,
      deps,
      // A couple of messages' worth of budget, then the deadline is behind us.
      clock: tickingClock(0, 100),
      budgetMs: 250,
    })

    // A budget stop is a HEALTHY tick: whatever was accepted is kept, the
    // mailbox is marked ok, and the rest is still in the mailbox next time.
    expect(out.ok).toBe(true)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.length).toBeLessThan(4)
    expect(lastCursor(db).last_ok_at).toBe(NOW_ISO)
    expect(lastCursor(db).last_uid).toBe(10 + calls.length)
    expect(logWarn).toHaveBeenCalledWith(
      'imap-poll', expect.stringContaining('tick budget spent'), expect.anything(),
    )
  })

  it('🔴 one slow tenant cannot starve the next — the sweep checks between mailboxes too', async () => {
    stubFetch({ status: 200 })
    let opened = 0
    const db = makeDb({
      mailboxes: [MAILBOX, OTHER_MAILBOX],
      credentials: {
        [MAILBOX.id]: credential(),
        [OTHER_MAILBOX.id]: credential({ mailbox_id: OTHER_MAILBOX.id, username: OTHER_MAILBOX.address }),
      },
    })

    const out = await pollAllMailboxes(db, {
      now: NOW,
      concurrency: 1,
      // Already past the deadline by the time the first mailbox is reached.
      clock: () => 10_000,
      budgetMs: 0,
      deps: {
        createClient: () => { opened += 1; return fakeImap({ uidNext: 11, messages: [] }).client },
      },
    })

    // Nothing is opened, nothing is recorded, and the sweep is still healthy —
    // an unstarted mailbox did not move its last_run_at, so it leads the next
    // tick's fair ordering.
    expect(opened).toBe(0)
    expect(out).toMatchObject({ ok: true, mailboxes: 2, failed: 0 })
    expect(db.state.upserts).toHaveLength(0)
    expect(logWarn).toHaveBeenCalledWith(
      'imap-poll', expect.stringContaining('budget spent'), expect.objectContaining({ unstarted: 2 }),
    )
  })

  it('an ordinary tick is nowhere near the budget and behaves exactly as before', async () => {
    stubFetch({ status: 200 })
    const { deps } = fakeImap({
      uidNext: 12, messages: [plainMessage(11)], bodies: { '11:1': 'a' },
    })
    const db = makeDb({
      credentials: { [MAILBOX.id]: credential() },
      ingress: {
        [`${MAILBOX.id}:inbox`]: {
          mailbox_id: MAILBOX.id, folder: 'inbox', uidvalidity: 12345, last_uid: 10,
          consecutive_failures: 0,
        },
      },
    })
    const out = await pollMailbox(db, MAILBOX, { now: NOW, deps })
    expect(out).toMatchObject({ ok: true, ingested: 1 })
  })
})

/* ═══════ 13. the mailbox list is paginated and fair ═════════════════ */

describe('listing connected mailboxes', () => {
  /** N mailboxes, ids ascending. */
  function estate(count) {
    return Array.from({ length: count }, (_, i) => ({
      id: `mbx-${String(i).padStart(4, '0')}`,
      location_id: 'loc-1',
      address: `m${i}@un1t.com`,
      label: `m${i}`,
      active: true,
      ingress: 'imap',
    }))
  }

  it('🔴 past the per-tick ceiling it polls the LEAST-RECENTLY-RUN, not the same 200 forever', async () => {
    // The old `.limit(200)` had no `.order()`, and PostgREST's physical order
    // is stable — so the same 200 rows came back every tick and orderByLastRun
    // "fairly" sorted a set that had already been truncated unfairly. The
    // mailboxes past it would never have been polled once, while the comment
    // above them promised "a mailbox cannot be starved".
    const mailboxes = estate(250)
    const ingress = {}
    const credentials = {}
    mailboxes.forEach((m, i) => {
      // The LAST 50 by id are the least recently run, so a fair tick takes
      // them and a truncate-first version structurally cannot.
      ingress[`${m.id}:inbox`] = {
        mailbox_id: m.id, folder: 'inbox', uidvalidity: 12345, last_uid: 10,
        consecutive_failures: 0,
        last_run_at: new Date(NOW - (i >= 200 ? 86_400_000 : 1000)).toISOString(),
      }
      credentials[m.id] = credential({ mailbox_id: m.id, username: m.address })
    })

    stubFetch({ status: 200 })
    const polled = []
    const db = makeDb({ mailboxes, credentials, ingress })

    const out = await pollAllMailboxes(db, {
      now: NOW,
      concurrency: 4,
      // One lane: the ceiling is per lane per tick, and `polled` counts dials.
      lanes: ['inbox'],
      deps: {
        createClient: (opts) => {
          polled.push(opts.auth.user)
          return fakeImap({ uidNext: 11, messages: [] }).client
        },
      },
    })

    expect(out.mailboxes).toBe(200)
    expect(polled).toHaveLength(200)
    for (let i = 200; i < 250; i += 1) expect(polled).toContain(`m${i}@un1t.com`)
  })

  it('reads the list in pages rather than one capped select', async () => {
    // 1200 rows at 500 per page is three pages, and the fake db refuses any
    // read of this table that does not carry a `.range()`.
    const db = makeDb({ mailboxes: estate(1200) })
    stubFetch({ status: 200 })

    await pollAllMailboxes(db, {
      now: NOW, concurrency: 1, deps: { createClient: () => fakeImap().client },
    })

    expect(db.state.reads.filter(r => r === 'pollable').length).toBeGreaterThanOrEqual(3)
  })
})

/* ═════════ 14. the sent lane — the sink, not the webhook ════════════ */

describe('the sent lane files a reply instead of posting it', () => {
  const sentCursor = {
    mailbox_id: MAILBOX.id, folder: 'sent', uidvalidity: 12345, last_uid: 10,
    consecutive_failures: 0, paused_until: null,
  }

  /** A mailbox seeded on the sent lane, with one reply waiting at uid 11. */
  function sentSetup({ ingress = { [`${MAILBOX.id}:sent`]: sentCursor } } = {}) {
    const { deps, client } = fakeImap({
      uidNext: 12, messages: [sentMessage(11)], bodies: { '11:1': 'Thanks, see you Tuesday.' },
    })
    const db = makeDb({ credentials: { [MAILBOX.id]: credential() }, ingress })
    return { deps, client, db }
  }

  it('🔴 a message in the Sent folder reaches fileClientSentReply and NEVER the inbound webhook', async () => {
    // THE test for this phase. `processInboundEmail` writes
    // `direction: 'inbound'` throughout, so POSTing a colleague's reply at the
    // inbound webhook would file the studio's own answer as though the member
    // had written it — a worse outcome than the divergence Phase 8 exists to
    // close, because it is wrong rather than merely missing.
    const { fn } = stubFetch({ status: 200 })
    const { deps, client, db } = sentSetup()

    const out = await pollMailbox(db, MAILBOX, { now: NOW, folder: 'sent', deps })

    expect(out).toMatchObject({ ok: true, ingested: 1, skipped: 0 })
    expect(fn).not.toHaveBeenCalled()
    expect(fileClientSentReply).toHaveBeenCalledTimes(1)

    // The PROVIDER-SPECIFIC folder off the credential row, still read-only.
    expect(client.timeline).toContainEqual(['mailboxOpen', '[Gmail]/Sent Mail', { readOnly: true }])

    // The writer is handed the mailbox row (it needs location_id to scope the
    // threading query), the raw message, and the same Postmark-shaped payload
    // the mapper builds for inbox — so the Sent lane reuses one body parser.
    const [dbArg, args] = fileClientSentReply.mock.calls[0]
    expect(dbArg).toBe(db)
    expect(args.mailbox).toBe(MAILBOX)
    expect(args.msg.uid).toBe(11)
    expect(args.payload.TextBody).toBe('Thanks, see you Tuesday.')
    // Threading is what makes the reply land on the right ticket at all.
    expect(args.payload.Headers.find(h => h.Name === 'In-Reply-To').Value).toBe('<m11@x.com>')
    expect(args.payload.Headers.find(h => h.Name === 'Message-ID').Value).toBe('<s11@mail.gmail.com>')
  })

  it('🔴 …and an INBOX message still goes to the webhook and never to the writer', async () => {
    // The other half of the seam. One lane changing behaviour is a feature;
    // both changing is a regression nobody would notice until a member's
    // question arrived as an outbound row.
    const { fn } = stubFetch({ status: 200 })
    const { deps } = fakeImap({
      uidNext: 12, messages: [plainMessage(11)], bodies: { '11:1': 'a' },
    })
    const db = makeDb({
      credentials: { [MAILBOX.id]: credential() },
      ingress: {
        [`${MAILBOX.id}:inbox`]: {
          mailbox_id: MAILBOX.id, folder: 'inbox', uidvalidity: 12345, last_uid: 10,
          consecutive_failures: 0,
        },
      },
    })

    const out = await pollMailbox(db, MAILBOX, { now: NOW, deps })

    expect(out).toMatchObject({ ok: true, ingested: 1 })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fileClientSentReply).not.toHaveBeenCalled()
  })

  it('🔴 the two lanes keep SEPARATE cursors on the same mailbox', async () => {
    // mig 572 put `folder` in the ingress primary key precisely so this needs
    // no migration. One shared cursor would make each lane jump the other's
    // watermark and lose everything between the two UID positions.
    stubFetch({ status: 200 })
    const db = makeDb({
      mailboxes: [MAILBOX],
      credentials: { [MAILBOX.id]: credential() },
      ingress: {
        [`${MAILBOX.id}:inbox`]: {
          mailbox_id: MAILBOX.id, folder: 'inbox', uidvalidity: 12345, last_uid: 10,
          consecutive_failures: 0,
        },
        [`${MAILBOX.id}:sent`]: { ...sentCursor, last_uid: 40 },
      },
    })
    const { deps } = fakeImapByFolder({
      'INBOX': { uidNext: 12, messages: [plainMessage(11)], bodies: { '11:1': 'a' } },
      '[Gmail]/Sent Mail': { uidNext: 42, messages: [sentMessage(41)], bodies: { '41:1': 'b' } },
    })

    await pollAllMailboxes(db, { now: NOW, concurrency: 1, deps })

    // Two rows, two watermarks, neither disturbed by the other.
    expect(db.state.ingress.get(`${MAILBOX.id}:inbox`).last_uid).toBe(11)
    expect(db.state.ingress.get(`${MAILBOX.id}:sent`).last_uid).toBe(41)
  })

  it('🔴 duplicate and orphan are HANDLED — both advance the watermark', async () => {
    // The contract's own words. A `duplicate` is a reply already on the ticket
    // (ours over SMTP, or one a previous tick filed); an `orphan` is a reply
    // on a thread we never ingested, which the writer deliberately does NOT
    // conjure a ticket for. Re-reading either next tick produces the same
    // answer forever, so holding the watermark would stall the lane on a
    // message nothing can change — a denial of the whole Sent folder.
    for (const outcome of ['duplicate', 'orphan']) {
      vi.clearAllMocks()
      fileClientSentReply.mockResolvedValue({ ok: true, outcome, ticketId: 'tkt-1' })
      stubFetch({ status: 200 })
      const { deps, db } = sentSetup()

      const out = await pollMailbox(db, MAILBOX, { now: NOW, folder: 'sent', deps })

      expect(out).toMatchObject({ ok: true, ingested: 1 })
      const cursor = lastCursor(db, MAILBOX.id, 'sent')
      expect(cursor.last_uid).toBe(11)
      expect(cursor.last_ok_at).toBe(NOW_ISO)
      expect(cursor.consecutive_failures).toBe(0)
    }
  })

  it('🔴 ok:false does NOT advance the watermark — it is a 5xx by another name', async () => {
    // Identical to the inbox lane's rule and for identical reasons: the writer
    // recorded nothing, so advancing past this reply would drop it on the
    // floor silently and forever. The next tick reads the same message.
    fileClientSentReply.mockResolvedValue({ ok: false, reason: 'insert_failed', error: new Error('deadlock detected') })
    stubFetch({ status: 200 })
    const { deps, db } = sentSetup()

    const out = await pollMailbox(db, MAILBOX, { now: NOW, folder: 'sent', deps })

    expect(out).toMatchObject({ ok: false, ingested: 0, skipped: 0, reason: 'forward_failed' })
    const cursor = lastCursor(db, MAILBOX.id, 'sent')
    expect(cursor.last_uid).toBeUndefined()
    expect(db.state.ingress.get(`${MAILBOX.id}:sent`).last_uid).toBe(10)
    // Counted and backed off exactly as a failing forward is — the settings
    // card is what tells an operator a lane has stopped.
    expect(cursor.consecutive_failures).toBe(1)
    // 🔴 The machine reason reaches the log; `last_error` stays a sentence a
    // customer-tier owner can read, with no database internals in it
    // (MAILBOX-CONNECT.8).
    expect(logWarn).toHaveBeenCalledWith(
      'imap-poll', expect.stringContaining('could not file a reply'),
      expect.objectContaining({ uid: 11, reason: 'insert_failed' }),
    )
    expect(cursor.last_error).not.toMatch(/deadlock/)
  })

  it('a writer that THROWS is retryable too — a bug must not cost the reply', async () => {
    // The contract says it never throws. If it ever does, the reply is still
    // in the customer's Sent folder and the watermark has not moved, so the
    // next tick tries again: a broken promise costs a tick, not a message.
    fileClientSentReply.mockRejectedValue(new Error('boom'))
    stubFetch({ status: 200 })
    const { deps, db } = sentSetup()

    const out = await pollMailbox(db, MAILBOX, { now: NOW, folder: 'sent', deps })

    expect(out).toMatchObject({ ok: false, reason: 'forward_failed' })
    expect(db.state.ingress.get(`${MAILBOX.id}:sent`).last_uid).toBe(10)
    expect(logError).toHaveBeenCalledWith(
      'imap-poll', expect.stringContaining('sent-lane writer threw'), expect.objectContaining({ uid: 11 }),
    )
  })

  it('🔴 stages NO attachment bytes, and says so rather than losing them in silence', async () => {
    // The sent lane writes a message row and nothing else, so staged bytes
    // would sit in the metered bucket with nothing that will ever name them —
    // billed against the mailbox's quota, invisible. Skipping the upload is
    // right; skipping it QUIETLY would not be, because a colleague's attached
    // file genuinely does not reach the ticket.
    stubFetch({ status: 200 })
    const withFile = sentMessage(11)
    withFile.bodyStructure = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', encoding: '7bit', size: 40 },
        {
          part: '2', type: 'application/pdf', encoding: 'base64', size: 900,
          disposition: 'attachment', dispositionParameters: { filename: 'invoice.pdf' },
        },
      ],
    }
    const { deps } = fakeImap({
      uidNext: 12, messages: [withFile], bodies: { '11:1': 'see attached' },
    })
    const db = makeDb({
      credentials: { [MAILBOX.id]: credential() },
      ingress: { [`${MAILBOX.id}:sent`]: sentCursor },
    })

    const out = await pollMailbox(db, MAILBOX, { now: NOW, folder: 'sent', deps })

    expect(out).toMatchObject({ ok: true, ingested: 1 })
    // Nothing uploaded, so nothing to orphan and nothing to discard.
    expect(db.state.uploads).toHaveLength(0)
    expect(db.state.removed).toHaveLength(0)
    expect(fileClientSentReply.mock.calls[0][1].payload.Attachments).toEqual([])
    expect(logWarn).toHaveBeenCalledWith(
      'imap-poll',
      expect.stringContaining('NOT recorded on the ticket'),
      expect.objectContaining({ uid: 11, files: 1 }),
    )
  })

  it('files replies even when the inbound webhook token is missing', async () => {
    // The lane posts nothing, so it needs no forward target. Tying it to one
    // would mean a deployment that lost an env var also stopped recording that
    // members had been answered — for no reason at all.
    delete process.env.POSTMARK_EMAIL_INBOX_WEBHOOK_TOKEN
    const { fn } = stubFetch({ status: 200 })
    const { deps, db } = sentSetup()

    const out = await pollMailbox(db, MAILBOX, { now: NOW, folder: 'sent', deps })

    expect(out).toMatchObject({ ok: true, ingested: 1 })
    expect(fn).not.toHaveBeenCalled()
    expect(lastCursor(db, MAILBOX.id, 'sent').last_uid).toBe(11)
  })

  it('🔴 the stall escape binds this lane too — a reply nothing can file is eventually dead-lettered', async () => {
    // "Retry" needs a floor here for exactly the reason it needs one on the
    // inbox lane: a reply the writer refuses every single time would otherwise
    // park the Sent folder forever, and every later reply with it. The probe
    // is what proves the writer is healthy before anything is stepped over.
    fileClientSentReply
      .mockResolvedValueOnce({ ok: false, reason: 'insert_failed' })
      .mockResolvedValue({ ok: true, outcome: 'filed', ticketId: 'tkt-1' })
    stubFetch({ status: 200 })
    const { deps } = fakeImap({
      uidNext: 14,
      messages: [sentMessage(11), sentMessage(12), sentMessage(13)],
      bodies: { '11:1': 'a', '12:1': 'b', '13:1': 'c' },
    })
    const db = makeDb({
      credentials: { [MAILBOX.id]: credential() },
      // 12 consecutive zero-progress ticks — MAX_STALL_TICKS.
      ingress: { [`${MAILBOX.id}:sent`]: { ...sentCursor, consecutive_failures: 12 } },
    })

    const out = await pollMailbox(db, MAILBOX, { now: NOW, folder: 'sent', deps })

    expect(out).toMatchObject({ ok: true, ingested: 2, skipped: 1 })
    expect(lastCursor(db, MAILBOX.id, 'sent').last_uid).toBe(13)
    expect(logError).toHaveBeenCalledWith(
      'imap-poll', expect.stringContaining('DEAD-LETTERED'),
      expect.objectContaining({ uid: 11, folder: 'sent' }),
    )
  })

  it('cold start on the sent lane ingests NOTHING, exactly as inbox does', async () => {
    // A mailbox connected mid-conversation must not have its whole Sent folder
    // filed as fresh outbound rows on tickets that may not exist.
    stubFetch({ status: 200 })
    const { deps, db } = sentSetup({ ingress: {} })

    const out = await pollMailbox(db, MAILBOX, { now: NOW, folder: 'sent', deps })

    expect(out).toMatchObject({ ok: true, ingested: 0, reason: 'cold_start' })
    expect(fileClientSentReply).not.toHaveBeenCalled()
    expect(lastCursor(db, MAILBOX.id, 'sent').last_uid).toBe(11)
  })
})

/* ═══════ 15. one tick, two lanes, one budget ════════════════════════ */

describe('a sweep polls inbox first and then sent, on one shared budget', () => {
  it('🔴 sweeps both lanes of a mailbox in one tick, INBOX FIRST', async () => {
    const { calls } = stubFetch({ status: 200 })
    const db = makeDb({
      mailboxes: [MAILBOX],
      credentials: { [MAILBOX.id]: credential() },
      ingress: {
        [`${MAILBOX.id}:inbox`]: {
          mailbox_id: MAILBOX.id, folder: 'inbox', uidvalidity: 12345, last_uid: 10,
          consecutive_failures: 0,
        },
        [`${MAILBOX.id}:sent`]: {
          mailbox_id: MAILBOX.id, folder: 'sent', uidvalidity: 12345, last_uid: 40,
          consecutive_failures: 0,
        },
      },
    })
    const { deps, timeline } = fakeImapByFolder({
      'INBOX': { uidNext: 12, messages: [plainMessage(11)], bodies: { '11:1': 'question' } },
      '[Gmail]/Sent Mail': { uidNext: 42, messages: [sentMessage(41)], bodies: { '41:1': 'answer' } },
    })

    const out = await pollAllMailboxes(db, { now: NOW, concurrency: 1, deps })

    // One member question forwarded, one colleague reply filed.
    expect(calls).toHaveLength(1)
    expect(fileClientSentReply).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({
      ok: true, mailboxes: 1, ingested: 2, failed: 0,
      lanes: {
        inbox: { ingested: 1, failed: 0, unconfigured: 0 },
        sent: { ingested: 1, failed: 0, unconfigured: 0 },
      },
    })

    // 🔴 THE ORDER. Receiving a member's question matters more than recording
    // that a colleague answered one, so inbox is opened first — always.
    const opened = timeline.filter(e => Array.isArray(e) && e[0] === 'mailboxOpen').map(e => e[1])
    expect(opened).toEqual(['INBOX', '[Gmail]/Sent Mail'])
  })

  it('🔴 SENT NEVER STARVES INBOX: a budget spent by the inbox lane skips sent cleanly', async () => {
    // The property the phase brief calls non-negotiable. Nothing is lost by
    // skipping: the sent cursor did not move, so the next tick reads the same
    // replies — where a sweep that ran sent first, or split the budget, would
    // have delayed a member's own mail to record the studio's answer.
    stubFetch({ status: 200 })
    let inboxDone = false
    const db = makeDb({
      mailboxes: [MAILBOX],
      credentials: { [MAILBOX.id]: credential() },
      ingress: {
        [`${MAILBOX.id}:inbox`]: {
          mailbox_id: MAILBOX.id, folder: 'inbox', uidvalidity: 12345, last_uid: 10,
          consecutive_failures: 0,
        },
        [`${MAILBOX.id}:sent`]: {
          mailbox_id: MAILBOX.id, folder: 'sent', uidvalidity: 12345, last_uid: 40,
          consecutive_failures: 0,
        },
      },
    })
    const built = fakeImapByFolder({
      'INBOX': { uidNext: 12, messages: [plainMessage(11)], bodies: { '11:1': 'question' } },
      '[Gmail]/Sent Mail': { uidNext: 42, messages: [sentMessage(41)], bodies: { '41:1': 'answer' } },
    })
    // The clock is spent the moment the inbox lane closes its folder — which
    // is a real shape (a mailbox draining a backlog), stated deterministically.
    const realLogout = built.client.logout
    built.client.logout = async function logout() { inboxDone = true; return realLogout.call(this) }

    const out = await pollAllMailboxes(db, {
      now: NOW, concurrency: 1, deps: built.deps,
      budgetMs: 1000,
      clock: () => (inboxDone ? 10_000 : 0),
    })

    // Inbox got its whole tick…
    expect(out.lanes.inbox.ingested).toBe(1)
    expect(db.state.ingress.get(`${MAILBOX.id}:inbox`).last_uid).toBe(11)
    // …and sent was not started at all: no writer call, no cursor movement,
    // and the tick is still HEALTHY rather than a failure.
    expect(fileClientSentReply).not.toHaveBeenCalled()
    expect(db.state.ingress.get(`${MAILBOX.id}:sent`).last_uid).toBe(40)
    expect(out).toMatchObject({ ok: true, failed: 0 })
    expect(built.timeline.filter(e => Array.isArray(e) && e[0] === 'mailboxOpen')).toHaveLength(1)
    // Visible, because a lane silently never running is the shape that hides a
    // slow tenant.
    expect(logWarn).toHaveBeenCalledWith(
      'imap-poll', expect.stringContaining('inbox is swept first on purpose'),
      expect.objectContaining({ lane: 'sent' }),
    )
  })

  it('🔴 a mailbox with no Sent folder is counted as unconfigured, never as failed', async () => {
    // It must not increment consecutive_failures, must not pause anything, and
    // must not read as a broken mailbox in the heartbeat — the "other"
    // provider preset ships an empty Sent box, so this is an ordinary state
    // that every tick will meet again.
    stubFetch({ status: 200 })
    const db = makeDb({
      mailboxes: [MAILBOX],
      credentials: { [MAILBOX.id]: credential({ sent_folder: null }) },
      ingress: {
        [`${MAILBOX.id}:inbox`]: {
          mailbox_id: MAILBOX.id, folder: 'inbox', uidvalidity: 12345, last_uid: 10,
          consecutive_failures: 0,
        },
      },
    })
    const { deps, timeline } = fakeImapByFolder({
      'INBOX': { uidNext: 12, messages: [plainMessage(11)], bodies: { '11:1': 'question' } },
    })

    const out = await pollAllMailboxes(db, { now: NOW, concurrency: 1, deps })

    expect(out).toMatchObject({
      ok: true, failed: 0, ingested: 1,
      lanes: { inbox: { ingested: 1, failed: 0 }, sent: { failed: 0, unconfigured: 1 } },
    })
    // The Sent folder is never opened and no cursor row is written for it.
    expect(timeline.filter(e => Array.isArray(e) && e[0] === 'mailboxOpen')).toHaveLength(1)
    expect(db.state.ingress.has(`${MAILBOX.id}:sent`)).toBe(false)
    expect(fileClientSentReply).not.toHaveBeenCalled()
  })

  it('one lane failing does not stop the other — the lanes are as isolated as the mailboxes', async () => {
    // A revoked app password fails both lanes, but a writer outage must not
    // stop a member's question arriving.
    stubFetch({ status: 200 })
    fileClientSentReply.mockResolvedValue({ ok: false, reason: 'insert_failed' })
    const db = makeDb({
      mailboxes: [MAILBOX],
      credentials: { [MAILBOX.id]: credential() },
      ingress: {
        [`${MAILBOX.id}:inbox`]: {
          mailbox_id: MAILBOX.id, folder: 'inbox', uidvalidity: 12345, last_uid: 10,
          consecutive_failures: 0,
        },
        [`${MAILBOX.id}:sent`]: {
          mailbox_id: MAILBOX.id, folder: 'sent', uidvalidity: 12345, last_uid: 40,
          consecutive_failures: 0,
        },
      },
    })
    const { deps } = fakeImapByFolder({
      'INBOX': { uidNext: 12, messages: [plainMessage(11)], bodies: { '11:1': 'question' } },
      '[Gmail]/Sent Mail': { uidNext: 42, messages: [sentMessage(41)], bodies: { '41:1': 'answer' } },
    })

    const out = await pollAllMailboxes(db, { now: NOW, concurrency: 1, deps })

    expect(out).toMatchObject({
      ok: true, ingested: 1, failed: 1,
      lanes: { inbox: { ingested: 1, failed: 0 }, sent: { ingested: 0, failed: 1 } },
    })
    expect(db.state.ingress.get(`${MAILBOX.id}:inbox`).last_uid).toBe(11)
    expect(db.state.ingress.get(`${MAILBOX.id}:sent`).last_uid).toBe(40)
    expect(db.state.ingress.get(`${MAILBOX.id}:sent`).consecutive_failures).toBe(1)
  })
})
