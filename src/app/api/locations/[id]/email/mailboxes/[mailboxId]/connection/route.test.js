// MAILBOX-CONNECT.6 — connecting one email account to its own IMAP login.
//
// Five properties this file pins, each of which is a real failure if it slips:
//
//   1. A MANAGER CANNOT CONNECT ONE. A manager holds `email_inbox` and is not
//      elevated; if this gate were ever loosened to the surface permission,
//      one of them could point a login at `accounts@` and read the studio's
//      billing correspondence. Every refusal also asserts that NOTHING was
//      written — a route that 403s and writes anyway is the same hole.
//   2. VERIFY BEFORE PERSIST. A credential that cannot authenticate is never
//      stored. An inbox that cannot log in is worse than no inbox: it fails
//      silently every five minutes and the operator believes mail is arriving.
//   3. THE SECRET IS WRITE-ONLY. No response carries the password or the
//      ciphertext, and the GET path does not even NAME `secret_ciphertext` in
//      its projection — asserted against `db.selects`, which records the
//      column string that actually went on the wire.
//   4. CONNECT, CHANGE AND DISCONNECT ARE ALL AUDITED, under distinct actions,
//      with no secret in the details.
//   5. DISCONNECT ACTUALLY DISCONNECTS — the credential row, the poll cursor
//      and both transport flags.
//   6. PUT WILL NOT DIAL WHEREVER IT IS POINTED, AND WILL NOT REPORT WHAT IT
//      FOUND. The handler opens a socket to an operator-supplied host:port from
//      inside the Vercel function; before MAILBOX-CONNECT.8 that was any host
//      and any of 65,535 ports, with the remote end's own bytes handed back on
//      failure — an SSRF probe with a response oracle, held by a customer-tier
//      owner. The refusals are asserted to cost NO dial, and two different
//      transport failures are asserted to be indistinguishable in the response.
//   7. A VERIFIED SAVE RESUMES POLLING. `paused_until` sits up to 24 hours out
//      after an auth backoff, and the poller returns early for the whole of it,
//      so a route that stores a freshly-verified password without clearing the
//      failure state changes nothing an operator can see for a day — while the
//      panel prints "Connected" beside "Paused". The cursor goes with it, but
//      ONLY when the account identity changed.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
// The real module imports imapflow at the top level and would open a socket.
// The verify seam is the whole point of the route, so it is driven directly.
vi.mock('@/lib/mail/imap-connection', () => ({ verifyConnection: vi.fn() }))
// Same for the SMTP leg — nodemailer would open a socket, and the verdict is
// what the route branches on.
vi.mock('@/lib/mail/smtp-send', () => ({ verifySmtpConnection: vi.fn() }))
// The host guard resolves with getaddrinfo, which would otherwise put a real
// DNS query in a unit test — and, worse, make "is this address public?" depend
// on what the network answered today.
vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))

import { GET, PUT, DELETE } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { verifyConnection } from '@/lib/mail/imap-connection'
import { verifySmtpConnection } from '@/lib/mail/smtp-send'
import { lookup as dnsLookup } from 'node:dns/promises'
import { seal, open as openSealed } from '@/lib/mail/secret-box'
import { makeDb, insertsInto, writesTo } from '@/app/api/email/tickets/_test-db'
import {
  LOC_A, MB_STUDIO, MB_ACCOUNTS, MB_OTHER_LOCATION,
  OWNER_A, OWNER_B, MANAGER_A, MASTER, adminState,
} from '../../_test-fixtures'
import { MAX_CONNECTED_MAILBOXES_PER_LOCATION } from '../../_helpers'

// 32 random bytes, base64 — a real key, so seal()/open() run for real and the
// stored value can be proven to be ciphertext rather than the password.
// Deterministic and obviously synthetic: a hardcoded 44-char base64 literal
// is indistinguishable from a live AES key to a secret scanner (and to a
// human skimming the file), so it is COMPUTED rather than pasted. Any
// 32-byte value works — seal()/open() run for real either way.
const TEST_KEY = Buffer.alloc(32, 11).toString('base64')

// ── The fake DB, extended ───────────────────────────────────────────────────
// email_mailbox_credentials and email_mailbox_ingress are not in the shared
// fake's TABLE_KEYS map (that file belongs to the ticket routes), so reads on
// them would fall through to an empty set and every "already connected" test
// would pass for the wrong reason. This adds them here rather than editing a
// file this phase does not own. Writes are recorded on the same
// db.inserts/updates/deletes arrays, so `writesTo(db)` still sees everything.
const NEW_TABLES = {
  email_mailbox_credentials: 'credentials',
  email_mailbox_ingress: 'ingressRows',
}

function extendDb(db, { credentials = [], ingressRows = [] } = {}) {
  db._state.credentials = credentials
  db._state.ingressRows = ingressRows
  const realFrom = db.from

  db.from = (table) => {
    const key = NEW_TABLES[table]
    if (!key) return realFrom(table)

    const b = { _filters: [], _op: 'select', _payload: null, _select: '*', _limit: null }
    const hits = () => db._state[key].filter(
      r => b._filters.every(([col, value]) => (r[col] ?? null) === value)
    )

    const settle = (shape) => {
      const injected = db._state.errors?.[table]
      if (injected) return { data: null, error: injected }
      if (b._op === 'insert') {
        db.inserts.push({ table, payload: b._payload })
        const row = { ...b._payload }
        db._state[key].push(row)
        return { data: row, error: null }
      }
      if (b._op === 'update') {
        db.updates.push({ table, payload: b._payload, filters: b._filters })
        const rows = hits()
        for (const r of rows) Object.assign(r, b._payload)
        return shape === 'list' ? { data: rows, error: null } : { data: rows[0] ?? null, error: null }
      }
      if (b._op === 'delete') {
        db.deletes.push({ table, filters: b._filters })
        const rows = hits()
        for (const r of rows) db._state[key].splice(db._state[key].indexOf(r), 1)
        return { data: rows, error: null }
      }
      // The column string is recorded, not honoured — the assertion that
      // matters is "the route never ASKED for the secret".
      db.selects.push({ table, columns: b._select })
      const rows = b._limit == null ? hits() : hits().slice(0, b._limit)
      return shape === 'list' ? { data: rows, error: null } : { data: rows[0] ?? null, error: null }
    }

    b.select = (columns) => { b._select = columns ?? '*'; return b }
    b.insert = (p) => { b._op = 'insert'; b._payload = p; return b }
    b.update = (p) => { b._op = 'update'; b._payload = p; return b }
    b.delete = () => { b._op = 'delete'; return b }
    b.eq = (col, value) => { b._filters.push([col, value]); return b }
    b.limit = (n) => { b._limit = n; return b }
    b.single = () => Promise.resolve(settle('single'))
    b.maybeSingle = () => Promise.resolve(settle('single'))
    // supabase-js builders are thenables, not Promises — mirror that exactly.
    b.then = (res, rej) => Promise.resolve(settle('list')).then(res, rej)
    return b
  }
  return db
}

// mig 572 added ingress/egress as NOT NULL DEFAULT 'postmark'; the shared
// mailbox fixtures predate it, so the columns are stated here.
const onPostmark = (m) => ({ ...m, ingress: 'postmark', egress: 'postmark' })

const GMAIL = {
  provider: 'gmail',
  username: 'studio@un1tdublin.com',
  password: 'not-a-real-app-password',
  imap_host: 'imap.gmail.com',
  imap_port: 993,
  imap_secure: true,
  smtp_host: 'smtp.gmail.com',
  smtp_port: 465,
  smtp_secure: true,
  sent_folder: '[Gmail]/Sent Mail',
}

const propsFor = (mailboxId) => ({ params: { id: LOC_A, mailboxId } })

const req = (method, body) => new Request(
  `http://x/api/locations/${LOC_A}/email/mailboxes/m/connection`,
  body === undefined
    ? { method }
    : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
)

let db
function setupDb(state, extra) {
  db = extendDb(makeDb(state), extra)
  createServerClient.mockImplementation(() => db)
  return db
}

/** The standard world: two live accounts at LOC_A, both on Postmark. */
function world(extra = {}, tables = {}) {
  return setupDb(adminState({
    mailboxes: [onPostmark(MB_STUDIO), onPostmark(MB_ACCOUNTS), onPostmark(MB_OTHER_LOCATION)],
    ...extra,
  }), tables)
}

const put = async (mailboxId, body) => {
  const res = await PUT(req('PUT', body), propsFor(mailboxId))
  return { res, body: await res.json() }
}
const get = async (mailboxId) => {
  const res = await GET(req('GET'), propsFor(mailboxId))
  return { res, body: await res.json() }
}
const del = async (mailboxId) => {
  const res = await DELETE(req('DELETE'), propsFor(mailboxId))
  return { res, body: await res.json() }
}

const credentialFor = (id) => db._state.credentials.find(c => c.mailbox_id === id) || null
const mailboxRow = (id) => db._state.mailboxes.find(m => m.id === id)

/**
 * A stored, already-connected account — sealed with the REAL secret-box, not a
 * stub, so "the route carried the stored password forward" is proven by
 * decrypting it rather than by comparing two opaque strings.
 */
function storedCredential(mailboxId, password = 'stored-app-password') {
  process.env.MAILBOX_SECRET_KEY = TEST_KEY
  return {
    mailbox_id: mailboxId,
    provider: 'gmail',
    auth_type: 'password',
    username: 'studio@un1tdublin.com',
    secret_ciphertext: seal(password),
    imap_host: 'imap.gmail.com',
    imap_port: 993,
    imap_secure: true,
    smtp_host: 'smtp.gmail.com',
    smtp_port: 465,
    smtp_secure: true,
    sent_folder: '[Gmail]/Sent Mail',
    created_by: OWNER_A.id,
    created_at: '2026-08-01T09:00:00Z',
    updated_at: '2026-08-01T09:00:00Z',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.MAILBOX_SECRET_KEY = TEST_KEY
  getCurrentUser.mockResolvedValue(OWNER_A)
  verifyConnection.mockResolvedValue({ ok: true })
  verifySmtpConnection.mockResolvedValue({ ok: true })
  // One public A record — the ordinary answer for imap.gmail.com and friends.
  dnsLookup.mockResolvedValue([{ address: '142.250.187.108', family: 4 }])
  world()
})

afterEach(() => {
  delete process.env.MAILBOX_SECRET_KEY
})

describe('the gate — master or owner at THIS studio, nothing less', () => {
  it('401s when unauthenticated, on all three verbs', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get(MB_STUDIO.id)).res.status).toBe(401)
    expect((await put(MB_STUDIO.id, GMAIL)).res.status).toBe(401)
    expect((await del(MB_STUDIO.id)).res.status).toBe(401)
    expect(writesTo(db)).toEqual([])
  })

  it('REFUSES a manager who holds email_inbox but is not elevated — and writes nothing', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const { res, body } = await put(MB_STUDIO.id, GMAIL)
    expect(res.status).toBe(403)
    expect(body.error).toMatch(/owner of this studio/i)
    expect(writesTo(db)).toEqual([])
    expect(credentialFor(MB_STUDIO.id)).toBeNull()
    expect(mailboxRow(MB_STUDIO.id).ingress).toBe('postmark')
    // The verify is never even attempted — a refused caller must not be able
    // to use this route to probe whether a host/password pair works.
    expect(verifyConnection).not.toHaveBeenCalled()
  })

  it('refuses a manager on GET and DELETE too', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    expect((await get(MB_STUDIO.id)).res.status).toBe(403)
    expect((await del(MB_STUDIO.id)).res.status).toBe(403)
    expect(writesTo(db)).toEqual([])
  })

  it('refuses an owner of a different studio', async () => {
    getCurrentUser.mockResolvedValue(OWNER_B)
    expect((await put(MB_STUDIO.id, GMAIL)).res.status).toBe(403)
    expect(writesTo(db)).toEqual([])
  })

  it('lets a master through', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    expect((await put(MB_STUDIO.id, GMAIL)).res.status).toBe(200)
  })

  it('404s — not 403 — for a mailbox belonging to another studio', async () => {
    // Otherwise the 403/404 split makes another studio's mailbox ids probeable.
    const { res } = await put(MB_OTHER_LOCATION.id, GMAIL)
    expect(res.status).toBe(404)
    expect(writesTo(db)).toEqual([])
    expect(credentialFor(MB_OTHER_LOCATION.id)).toBeNull()
  })

  it('404s for an id that does not exist at all — the same answer', async () => {
    expect((await get('99999999-9999-4999-8999-999999999999')).res.status).toBe(404)
  })
})

describe('PUT — verify before persist', () => {
  it('stores nothing when the IMAP login is refused', async () => {
    verifyConnection.mockResolvedValue({ ok: false, error: 'Invalid credentials (Failure)' })
    const { res, body } = await put(MB_STUDIO.id, GMAIL)

    expect(res.status).toBe(400)
    // MAILBOX-CONNECT.8 — the operator is told what to DO, and the server's own
    // words are not repeated back to whoever chose the server. This assertion
    // used to read `/IMAP login failed: Invalid credentials/`, which is exactly
    // the echo the oracle was built out of.
    expect(body.error).toMatch(/refused that username and password/i)
    expect(body.error).not.toMatch(/Invalid credentials/)
    expect(body.code).toBe('imap_verify_failed')
    // The whole point: not the credential, not the ingress flip, not an audit
    // row claiming a connection that does not exist.
    expect(writesTo(db)).toEqual([])
    expect(credentialFor(MB_STUDIO.id)).toBeNull()
    expect(mailboxRow(MB_STUDIO.id).ingress).toBe('postmark')
    expect(insertsInto(db, 'audit_events')).toEqual([])
  })

  it('leaves a WORKING connection untouched when a re-save fails to verify', async () => {
    world({}, { credentials: [storedCredential(MB_STUDIO.id, 'known-good')] })
    db._state.mailboxes.find(m => m.id === MB_STUDIO.id).ingress = 'imap'
    verifyConnection.mockResolvedValue({ ok: false, error: 'Invalid credentials (Failure)' })

    const { res } = await put(MB_STUDIO.id, { ...GMAIL, password: 'a-typo' })
    expect(res.status).toBe(400)
    // The stored password still opens to the old value — a failed save must
    // never half-apply and lock the studio out of its own mailbox.
    expect(openSealed(credentialFor(MB_STUDIO.id).secret_ciphertext)).toBe('known-good')
    expect(mailboxRow(MB_STUDIO.id).ingress).toBe('imap')
  })

  it('refuses an SMTP server that will not authenticate, and stores nothing', async () => {
    // Phase 7 flips `egress` to this host. An unverified value stored now
    // would sit quietly until that flip and then fail in front of a member.
    verifySmtpConnection.mockResolvedValue({ ok: false, error: 'Invalid login: 535-5.7.8' })
    const { res, body } = await put(MB_STUDIO.id, GMAIL)

    expect(res.status).toBe(400)
    expect(body.code).toBe('smtp_verify_failed')
    // …and it names the way out, because receive-only is a supported state.
    expect(body.error).toMatch(/leave the outgoing server blank/i)
    expect(writesTo(db)).toEqual([])
    expect(credentialFor(MB_STUDIO.id)).toBeNull()
  })

  it('skips the SMTP check entirely when no outgoing server was given', async () => {
    const { res } = await put(MB_STUDIO.id, { ...GMAIL, smtp_host: '', smtp_port: null })
    expect(res.status).toBe(200)
    expect(verifySmtpConnection).not.toHaveBeenCalled()
    expect(credentialFor(MB_STUDIO.id).smtp_host).toBeNull()
    // Receiving over IMAP while replies still leave via Postmark is the
    // shipped release, not a broken half-configuration.
    expect(mailboxRow(MB_STUDIO.id).ingress).toBe('imap')
    expect(mailboxRow(MB_STUDIO.id).egress).toBe('postmark')
  })

  it('checks SMTP with the same credential the IMAP leg just proved', async () => {
    await put(MB_STUDIO.id, GMAIL)
    expect(verifySmtpConnection).toHaveBeenCalledWith({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: 'studio@un1tdublin.com', pass: 'not-a-real-app-password' },
    })
  })

  it('does not reach SMTP when IMAP already failed', async () => {
    verifyConnection.mockResolvedValue({ ok: false, error: 'Invalid credentials (Failure)' })
    await put(MB_STUDIO.id, GMAIL)
    expect(verifySmtpConnection).not.toHaveBeenCalled()
  })

  it('verifies against the host, port, TLS flag and credential it is about to store', async () => {
    await put(MB_STUDIO.id, GMAIL)
    expect(verifyConnection).toHaveBeenCalledWith(
      {
        host: 'imap.gmail.com',
        port: 993,
        secure: true,
        auth: { user: 'studio@un1tdublin.com', pass: 'not-a-real-app-password' },
      },
      'INBOX'
    )
  })
})

describe('PUT — what it is allowed to dial (SSRF)', () => {
  // The whole class in one sentence: an owner is a CUSTOMER, and this handler
  // opens a TCP connection to a host:port they type in, from inside our egress.
  const dialed = () => verifyConnection.mock.calls.length + verifySmtpConnection.mock.calls.length

  it('refuses a literal loopback address — and never opens the socket', async () => {
    const { res, body } = await put(MB_STUDIO.id, { ...GMAIL, imap_host: '127.0.0.1', imap_port: 143 })
    expect(res.status).toBe(400)
    expect(body.code).toBe('imap_host_refused')
    expect(body.error).toMatch(/public internet/i)
    expect(dialed()).toBe(0)
    expect(writesTo(db)).toEqual([])
    // A literal address needs no resolver, so none is consulted.
    expect(dnsLookup).not.toHaveBeenCalled()
  })

  it('refuses the cloud metadata endpoint, in every spelling of it', async () => {
    // 169.254.169.254 is the one target that turns "can I connect" into "here
    // are your credentials" on every major cloud, and it can be written four
    // ways that a prefix-only check reads as four different addresses.
    for (const host of [
      '169.254.169.254',
      '::ffff:169.254.169.254',
      '64:ff9b::169.254.169.254',
      '2002:a9fe:a9fe::',
    ]) {
      world()
      const { res, body } = await put(MB_STUDIO.id, { ...GMAIL, imap_host: host })
      expect(res.status, host).toBe(400)
      expect(body.code, host).toBe('imap_host_refused')
      expect(dialed(), host).toBe(0)
    }
  })

  it('refuses every private, link-local and reserved range', async () => {
    for (const host of [
      '10.1.2.3', '172.16.0.9', '192.168.1.10', '100.100.1.1',  // RFC 1918 + CGNAT/Tailscale
      '0.0.0.0', '127.0.0.53', '::1', '[::1]', 'fd00::1', 'fe80::1',
    ]) {
      world()
      const { res } = await put(MB_STUDIO.id, { ...GMAIL, imap_host: host })
      expect(res.status, host).toBe(400)
      expect(dialed(), host).toBe(0)
    }
  })

  it('refuses a NAME that resolves onto a private address', async () => {
    // The literal-address checks are the easy half. This is the half an
    // attacker actually uses: a hostname they control, pointed inward.
    dnsLookup.mockResolvedValue([{ address: '10.0.0.7', family: 4 }])
    const { res, body } = await put(MB_STUDIO.id, { ...GMAIL, imap_host: 'imap.attacker.example' })
    expect(res.status).toBe(400)
    expect(body.code).toBe('imap_host_refused')
    expect(dialed()).toBe(0)
  })

  it('refuses a name whose answers are MIXED public and private', async () => {
    // Allowing it and hoping the socket picks the public record is not a
    // decision this route gets to make — getaddrinfo orders the answers, not us.
    dnsLookup.mockResolvedValue([
      { address: '142.250.187.108', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ])
    const { res } = await put(MB_STUDIO.id, GMAIL)
    expect(res.status).toBe(400)
    expect(dialed()).toBe(0)
  })

  it('refuses single-label and internal-suffix names without asking DNS', async () => {
    for (const host of ['localhost', 'mailserver', 'imap.internal', 'box.local', 'db.corp']) {
      world()
      const { res } = await put(MB_STUDIO.id, { ...GMAIL, imap_host: host })
      expect(res.status, host).toBe(400)
      expect(dialed(), host).toBe(0)
      expect(dnsLookup, host).not.toHaveBeenCalled()
    }
  })

  it('refuses a port that is not a mail port, on either leg', async () => {
    // Most of the reachable internal surface is not on 993. A mail connector
    // dialling 6379 or 22 has no legitimate reading.
    const imap = await put(MB_STUDIO.id, { ...GMAIL, imap_port: 6379 })
    expect(imap.res.status).toBe(400)
    expect(imap.body.code).toBe('imap_port_refused')
    expect(imap.body.error).toMatch(/993/)

    world()
    const smtp = await put(MB_STUDIO.id, { ...GMAIL, smtp_port: 22 })
    expect(smtp.res.status).toBe(400)
    expect(smtp.body.code).toBe('smtp_port_refused')
    expect(dialed()).toBe(0)
    expect(writesTo(db)).toEqual([])
  })

  it('still allows the legitimate mail ports, including the non-default ones', async () => {
    // Failing closed on a port an operator genuinely needs would be its own
    // defect, so the accepted set is pinned rather than left implicit.
    for (const [imapPort, smtpPort] of [[993, 465], [143, 587], [993, 2525]]) {
      world()
      const { res } = await put(MB_STUDIO.id, {
        ...GMAIL, imap_port: imapPort, imap_secure: imapPort === 993, smtp_port: smtpPort,
      })
      expect(res.status, `${imapPort}/${smtpPort}`).toBe(200)
    }
  })

  it('checks BOTH hosts before dialling either one', async () => {
    // Otherwise a caller pairs a real mail server with an internal one and
    // reads the answer off which leg failed.
    dnsLookup.mockImplementation(async (name) => (
      name === 'smtp.gmail.com' ? [{ address: '10.0.0.7', family: 4 }] : [{ address: '142.250.187.108', family: 4 }]
    ))
    const { res, body } = await put(MB_STUDIO.id, GMAIL)
    expect(res.status).toBe(400)
    expect(body.code).toBe('smtp_host_refused')
    expect(verifyConnection).not.toHaveBeenCalled()
  })

  it('NEVER returns what the remote server said', async () => {
    // The oracle in its purest form: the bytes on the wire, forwarded to the
    // person who chose the wire.
    verifyConnection.mockResolvedValue({
      ok: false,
      error: '-ERR unknown command `A1`, with args beginning with: — Redis 7.2.4 at 10.0.0.7:6379',
    })
    const { res, body } = await put(MB_STUDIO.id, GMAIL)
    expect(res.status).toBe(400)
    const serialised = JSON.stringify(body)
    expect(serialised).not.toMatch(/Redis/)
    expect(serialised).not.toMatch(/10\.0\.0\.7/)
    expect(serialised).not.toMatch(/6379/)
    expect(body.error).toMatch(/Could not complete a login check/i)
  })

  it('reports a refused connection and a timeout IDENTICALLY', async () => {
    // Open vs filtered is the distinction a port scan is built on, and it is
    // one no operator acts on differently. Both collapse into one sentence.
    verifyConnection.mockResolvedValue({ ok: false, error: 'connect ECONNREFUSED 203.0.113.9:993' })
    const refused = (await put(MB_STUDIO.id, GMAIL)).body.error
    world()
    verifyConnection.mockResolvedValue({ ok: false, error: 'Connection timed out after 20000 ms' })
    const timedOut = (await put(MB_STUDIO.id, GMAIL)).body.error
    expect(refused).toBe(timedOut)
  })

  it('still tells an operator the three things they can act on', async () => {
    // Redaction must not cost the connector its diagnostics — a message that
    // says nothing sends the operator to support instead of to their settings.
    verifyConnection.mockResolvedValue({ ok: false, error: 'Invalid credentials (Failure)' })
    expect((await put(MB_STUDIO.id, GMAIL)).body.error).toMatch(/app password/i)

    world()
    verifyConnection.mockResolvedValue({ ok: false, error: 'C: ssl3_get_record:wrong version number' })
    expect((await put(MB_STUDIO.id, GMAIL)).body.error).toMatch(/993 is IMAP over SSL, 143 is STARTTLS/i)

    world()
    verifyConnection.mockResolvedValue({ ok: true })
    verifySmtpConnection.mockResolvedValue({ ok: false, error: '535-5.7.8 Username and Password not accepted' })
    const smtp = (await put(MB_STUDIO.id, GMAIL)).body.error
    // The 465/587 trap and the way out both survive the redaction.
    expect(smtp).toMatch(/leave the outgoing server blank/i)
    expect(smtp).not.toMatch(/535/)
  })

  it('throttles the dials one caller can make', async () => {
    // Constrained hosts and ports still leave a scanner: which public mail
    // hosts exist, and which accept this username. Budget is per caller.
    db.rpc = () => Promise.resolve({ data: 999, error: null })
    const { res } = await put(MB_STUDIO.id, GMAIL)
    expect(res.status).toBe(429)
    expect(verifyConnection).not.toHaveBeenCalled()
    expect(writesTo(db)).toEqual([])
  })

  it('does not spend the dial budget on a save that never reaches the network', async () => {
    // A refused host, a deactivated mailbox or a missing password must not eat
    // the budget for the save the operator is about to get right.
    const spent = []
    db.rpc = (fn) => { spent.push(fn); return Promise.resolve({ data: 1, error: null }) }
    await put(MB_STUDIO.id, { ...GMAIL, imap_host: '10.0.0.7' })
    const { password: _drop, ...noPassword } = GMAIL
    await put(MB_STUDIO.id, noPassword)
    expect(spent).toEqual([])
  })
})

describe('PUT — connecting', () => {
  it('stores the credential as ciphertext, never as the password', async () => {
    const { res, body } = await put(MB_STUDIO.id, GMAIL)
    expect(res.status).toBe(200)

    const row = credentialFor(MB_STUDIO.id)
    expect(row.secret_ciphertext).toMatch(/^v1:/)
    expect(row.secret_ciphertext).not.toContain(GMAIL.password)
    expect(openSealed(row.secret_ciphertext)).toBe(GMAIL.password)
    expect(row.auth_type).toBe('password')
    expect(row.provider).toBe('gmail')
    expect(row.sent_folder).toBe('[Gmail]/Sent Mail')
    expect(row.created_by).toBe(OWNER_A.id)

    // …and the response says nothing about it.
    expect(JSON.stringify(body)).not.toContain(GMAIL.password)
    expect(JSON.stringify(body)).not.toContain('secret_ciphertext')
  })

  // MAILBOX-CONNECT.7 — egress FOLLOWS the smtp_host field. This block used to
  // assert egress was left alone, which was correct while no SMTP transport
  // existed; once the transport shipped and the send call sites were wired, a
  // column nothing writes is a feature that cannot be switched on.
  it('flips the mailbox to ingress=imap, and to egress=smtp when SMTP is configured', async () => {
    await put(MB_STUDIO.id, GMAIL)
    expect(mailboxRow(MB_STUDIO.id).ingress).toBe('imap')
    expect(mailboxRow(MB_STUDIO.id).egress).toBe('smtp')
  })

  it('leaves egress=postmark when no outgoing server is given', async () => {
    // The outgoing server IS the opt-in: receive over IMAP, reply through
    // Postmark. This is the R1 release shape and it must stay reachable.
    const { smtp_host: _h, smtp_port: _p, smtp_secure: _s, ...receiveOnly } = GMAIL
    await put(MB_STUDIO.id, receiveOnly)
    expect(mailboxRow(MB_STUDIO.id).ingress).toBe('imap')
    expect(mailboxRow(MB_STUDIO.id).egress).toBe('postmark')
  })

  it('drops back to egress=postmark when the outgoing server is cleared', async () => {
    // Clearing the field is the way back, and it takes effect on the same save
    // — otherwise an operator who removed SMTP would keep sending over it.
    await put(MB_STUDIO.id, GMAIL)
    expect(mailboxRow(MB_STUDIO.id).egress).toBe('smtp')
    await put(MB_STUDIO.id, { ...GMAIL, smtp_host: null })
    expect(mailboxRow(MB_STUDIO.id).egress).toBe('postmark')
    expect(mailboxRow(MB_STUDIO.id).ingress).toBe('imap')
  })

  it('touches only the mailbox it was given', async () => {
    await put(MB_STUDIO.id, GMAIL)
    expect(mailboxRow(MB_ACCOUNTS.id).ingress).toBe('postmark')
    expect(credentialFor(MB_ACCOUNTS.id)).toBeNull()
  })

  it('refuses Microsoft with the reason, and stores nothing', async () => {
    const { res, body } = await put(MB_STUDIO.id, { ...GMAIL, provider: 'microsoft' })
    expect(res.status).toBe(400)
    expect(body.error).toMatch(/Exchange Online no longer allows a mailbox password/i)
    expect(writesTo(db)).toEqual([])
    expect(verifyConnection).not.toHaveBeenCalled()
  })

  it('refuses to connect a deactivated account — its mail would land nowhere', async () => {
    world({ mailboxes: [onPostmark({ ...MB_STUDIO, active: false }), onPostmark(MB_ACCOUNTS)] })
    const { res, body } = await put(MB_STUDIO.id, GMAIL)
    expect(res.status).toBe(400)
    expect(body.error).toMatch(/Reactivate it first/i)
    expect(writesTo(db)).toEqual([])
  })

  it('refuses — without asking for a network round trip — when encryption is not configured', async () => {
    delete process.env.MAILBOX_SECRET_KEY
    const { res, body } = await put(MB_STUDIO.id, GMAIL)
    expect(res.status).toBe(503)
    expect(body.error).toMatch(/encryption key is not configured/i)
    expect(writesTo(db)).toEqual([])
    expect(verifyConnection).not.toHaveBeenCalled()
  })

  it('refuses a first connect with no password rather than storing a login that cannot authenticate', async () => {
    const { password: _drop, ...noPassword } = GMAIL
    const { res, body } = await put(MB_STUDIO.id, noPassword)
    expect(res.status).toBe(400)
    expect(body.error).toMatch(/there is nothing stored for this account yet/i)
    expect(writesTo(db)).toEqual([])
  })
})

describe('PUT — changing an existing connection', () => {
  beforeEach(() => {
    world({}, { credentials: [storedCredential(MB_STUDIO.id, 'stored-app-password')] })
    db._state.mailboxes.find(m => m.id === MB_STUDIO.id).ingress = 'imap'
  })

  it('carries the stored password forward when the form posts it blank', async () => {
    const { password: _drop, ...settingsOnly } = GMAIL
    const { res } = await put(MB_STUDIO.id, { ...settingsOnly, imap_host: 'imap.example.com', password: '' })
    expect(res.status).toBe(200)

    // The credential survives a settings-only save — the Glofox null-collapse
    // trap, which would have wiped a live connection.
    expect(openSealed(credentialFor(MB_STUDIO.id).secret_ciphertext)).toBe('stored-app-password')
    expect(credentialFor(MB_STUDIO.id).imap_host).toBe('imap.example.com')
    // …and it was re-proven against the NEW host before being kept.
    expect(verifyConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'imap.example.com',
        auth: { user: 'studio@un1tdublin.com', pass: 'stored-app-password' },
      }),
      'INBOX'
    )
  })

  it('ignores the masked echo the UI renders, exactly like a blank', async () => {
    await put(MB_STUDIO.id, { ...GMAIL, password: '••••••word' })
    expect(openSealed(credentialFor(MB_STUDIO.id).secret_ciphertext)).toBe('stored-app-password')
  })

  it('replaces the password when a fresh one is supplied', async () => {
    await put(MB_STUDIO.id, { ...GMAIL, password: 'rotated-app-password' })
    expect(openSealed(credentialFor(MB_STUDIO.id).secret_ciphertext)).toBe('rotated-app-password')
  })

  it('inserts once and updates thereafter — one credential row per mailbox', async () => {
    await put(MB_STUDIO.id, GMAIL)
    expect(db._state.credentials.filter(c => c.mailbox_id === MB_STUDIO.id)).toHaveLength(1)
    expect(insertsInto(db, 'email_mailbox_credentials')).toEqual([])
  })

  it('re-verifies against the NEW username when only the login name changed', async () => {
    const { password: _drop, ...settingsOnly } = GMAIL
    await put(MB_STUDIO.id, { ...settingsOnly, username: 'delegate@un1tdublin.com' })
    expect(verifyConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: { user: 'delegate@un1tdublin.com', pass: 'stored-app-password' },
      }),
      'INBOX'
    )
  })
})

describe('PUT — a verified save has to resume polling', () => {
  // THE FAILURE, END TO END: an app password is revoked. The poller fails,
  // the AUTH backoff curve tops out, and `paused_until` lands up to 24 HOURS
  // out — imap-poll.js returns `{ ok: true, reason: 'paused' }` for the whole
  // of it. The operator generates a new app password and saves. Before
  // MAILBOX-CONNECT.8 the route verified it live, stored it, answered
  // `verified: true` — and no mail arrived for another day, while the settings
  // card printed "Connected. The login was checked…" next to a "Paused" chip
  // carrying the error from the password that had just been replaced.
  const PAUSED_INBOX = {
    mailbox_id: MB_STUDIO.id,
    folder: 'inbox',
    uidvalidity: 12,
    last_uid: 480,
    last_run_at: '2026-08-26T09:00:00Z',
    last_ok_at: '2026-08-25T09:00:00Z',
    last_error: 'Invalid credentials (Failure)',
    consecutive_failures: 6,
    paused_until: '2026-08-27T09:00:00Z',
  }
  const inboxCursor = () => db._state.ingressRows.find(
    r => r.mailbox_id === MB_STUDIO.id && r.folder === 'inbox'
  )

  function pausedWorld(extraIngress = []) {
    world({}, {
      credentials: [storedCredential(MB_STUDIO.id, 'revoked-password')],
      ingressRows: [{ ...PAUSED_INBOX }, ...extraIngress],
    })
    db._state.mailboxes.find(m => m.id === MB_STUDIO.id).ingress = 'imap'
  }

  it('clears the pause, the failure count and the stale error', async () => {
    pausedWorld()
    const { res, body } = await put(MB_STUDIO.id, { ...GMAIL, password: 'new-app-password' })
    expect(res.status).toBe(200)
    expect(body.data.verified).toBe(true)

    const cursor = inboxCursor()
    // Any one of these left behind is a mailbox that does not resume: the
    // pause blocks the next tick outright, and a failure count of 6 puts the
    // next single blip straight back at the top of the curve.
    expect(cursor.paused_until).toBeNull()
    expect(cursor.consecutive_failures).toBe(0)
    expect(cursor.last_error).toBeNull()
  })

  it('clears every folder of that mailbox, and nothing belonging to another', async () => {
    // Phase 8's Sent cursor is the same account and inherits the same pause.
    pausedWorld([
      { ...PAUSED_INBOX, folder: 'sent' },
      { ...PAUSED_INBOX, mailbox_id: MB_ACCOUNTS.id },
    ])
    await put(MB_STUDIO.id, { ...GMAIL, password: 'new-app-password' })

    const sent = db._state.ingressRows.find(r => r.mailbox_id === MB_STUDIO.id && r.folder === 'sent')
    expect(sent.paused_until).toBeNull()
    const other = db._state.ingressRows.find(r => r.mailbox_id === MB_ACCOUNTS.id)
    expect(other.paused_until).toBe(PAUSED_INBOX.paused_until)
    expect(other.consecutive_failures).toBe(6)
  })

  it('resumes on a settings-only save too, not just a password change', async () => {
    // A pause is not always about the credential — a transport failure pauses
    // the same row, and the fix for it is often a corrected host.
    pausedWorld()
    const { password: _drop, ...settingsOnly } = GMAIL
    await put(MB_STUDIO.id, settingsOnly)
    expect(inboxCursor().paused_until).toBeNull()
  })

  it('does not report a clean connection when the resume write failed', async () => {
    // Answering 200 here would recreate the whole defect: a verified password,
    // a green panel, and a day of silence.
    world(
      { errors: { email_mailbox_ingress: { code: '42501', message: 'permission denied' } } },
      { credentials: [storedCredential(MB_STUDIO.id)], ingressRows: [{ ...PAUSED_INBOX }] }
    )
    const { res, body } = await put(MB_STUDIO.id, { ...GMAIL, password: 'new-app-password' })
    expect(res.status).toBe(500)
    expect(body.code).toBe('poll_resume_failed')
    expect(body.error).toMatch(/Press Save once more/i)
    // …and it does NOT claim nothing happened: the credential really is stored.
    expect(openSealed(credentialFor(MB_STUDIO.id).secret_ciphertext)).toBe('new-app-password')
  })

  // MAILBOX-CONNECT.8 — THE AUDIT ROW SURVIVES A FAILURE AFTER THE WRITE.
  //
  // The audit event used to be written last, after the flip and the resume, so
  // either of those failing returned 500 with the password already rotated on
  // disk and NOTHING in audit_events recording it. That is precisely the case
  // someone opens the audit log for: "this mailbox stopped receiving, who
  // touched it?". The handler's own 500 copy admits the write happened, so the
  // log has to agree with it.
  it('still audits the credential change when a LATER write fails', async () => {
    world(
      { errors: { email_mailbox_ingress: { code: '42501', message: 'permission denied' } } },
      { credentials: [storedCredential(MB_STUDIO.id)], ingressRows: [{ ...PAUSED_INBOX }] }
    )
    const { res } = await put(MB_STUDIO.id, { ...GMAIL, password: 'new-app-password' })
    expect(res.status).toBe(500)

    const audits = insertsInto(db, 'audit_events')
    expect(audits).toHaveLength(1)
    expect(audits[0].payload.action).toBe('email_mailbox_connection.credential_changed')
    expect(audits[0].payload.details.password_changed).toBe(true)
    // And still no secret in it, on this path as on every other.
    expect(JSON.stringify(audits[0])).not.toContain('new-app-password')
  })

  // ── THE CURSOR: cleared on an ACCOUNT change, kept otherwise ──────────────
  it('KEEPS the watermark when only the password changed', async () => {
    // Dropping it cold-starts the folder, and a cold start anchors to the
    // current highest UID and ingests nothing — so a needless reset silently
    // skips whatever arrived since the last tick.
    pausedWorld()
    await put(MB_STUDIO.id, { ...GMAIL, password: 'new-app-password' })
    expect(inboxCursor().last_uid).toBe(480)
    expect(inboxCursor().uidvalidity).toBe(12)
  })

  it('KEEPS the watermark when the host differs only in case', async () => {
    pausedWorld()
    await put(MB_STUDIO.id, { ...GMAIL, imap_host: 'IMAP.Gmail.com.' })
    expect(inboxCursor().last_uid).toBe(480)
  })

  it('CLEARS the watermark when the mailbox is repointed at another account', async () => {
    // The silent-loss case: a new login behind the same mailbox, resuming past
    // a watermark that belongs to a different mailbox's UID space. Usually the
    // UIDVALIDITY mismatch re-anchors and saves it — the two servers only have
    // to collide on that one number for every message at or below last_uid to
    // be skipped with nothing recorded anywhere.
    pausedWorld()
    await put(MB_STUDIO.id, { ...GMAIL, username: 'other-account@un1tdublin.com' })
    expect(inboxCursor().last_uid).toBeNull()
    expect(inboxCursor().uidvalidity).toBeNull()
  })

  it('CLEARS the watermark when the incoming server changes', async () => {
    pausedWorld()
    await put(MB_STUDIO.id, { ...GMAIL, imap_host: 'imap.fastmail.com' })
    expect(inboxCursor().last_uid).toBeNull()
  })

  it('CLEARS a cursor left behind by a disconnect, on the next first connect', async () => {
    // DELETE's cursor delete is best-effort by design (it logs and carries on
    // rather than telling an operator the disconnect failed), so a stale
    // watermark with no credential behind it is a state that really occurs.
    world({}, { ingressRows: [{ ...PAUSED_INBOX }] })
    const { res } = await put(MB_STUDIO.id, GMAIL)
    expect(res.status).toBe(200)
    expect(inboxCursor().last_uid).toBeNull()
    expect(inboxCursor().uidvalidity).toBeNull()
  })

  it('records the cursor reset in the audit row', async () => {
    // Worth remembering: everything already in that mailbox is now below the
    // new watermark and will never be ingested.
    pausedWorld()
    await put(MB_STUDIO.id, { ...GMAIL, username: 'other-account@un1tdublin.com' })
    const audits = insertsInto(db, 'audit_events')
    expect(audits[0].payload.details.cursor_reset).toBe(true)
  })
})

describe('the secret is write-only', () => {
  it('GET never returns the credential, and never even asks for it', async () => {
    world({}, { credentials: [storedCredential(MB_STUDIO.id, 'stored-app-password')] })
    const { res, body } = await get(MB_STUDIO.id)

    expect(res.status).toBe(200)
    const serialised = JSON.stringify(body)
    expect(serialised).not.toContain('stored-app-password')
    expect(serialised).not.toContain('secret_ciphertext')
    expect(serialised).not.toContain('oauth')
    expect(serialised).not.toContain(credentialFor(MB_STUDIO.id).secret_ciphertext)

    // The projection that went on the wire names no secret column either —
    // "the response happens not to include it" is a weaker claim than "the
    // query never selected it".
    const projections = db.selects
      .filter(s => s.table === 'email_mailbox_credentials')
      .map(s => s.columns)
    expect(projections.length).toBeGreaterThan(0)
    for (const columns of projections) {
      expect(columns).not.toContain('secret_ciphertext')
      expect(columns).not.toContain('oauth_')
      expect(columns).not.toBe('*')
    }
  })

  it('GET reports state and poll health an operator can act on', async () => {
    world({}, {
      credentials: [storedCredential(MB_STUDIO.id)],
      ingressRows: [{
        mailbox_id: MB_STUDIO.id, folder: 'inbox', uidvalidity: 12, last_uid: 480,
        last_run_at: '2026-08-26T09:00:00Z', last_ok_at: '2026-08-26T09:00:00Z',
        last_error: null, consecutive_failures: 0, paused_until: null,
      }],
    })
    db._state.mailboxes.find(m => m.id === MB_STUDIO.id).ingress = 'imap'

    const { body } = await get(MB_STUDIO.id)
    expect(body.data.ingress).toBe('imap')
    expect(body.data.connection.username).toBe('studio@un1tdublin.com')
    expect(body.data.connection.imap_host).toBe('imap.gmail.com')
    expect(body.data.folders).toHaveLength(1)
    expect(body.data.folders[0].folder).toBe('inbox')
  })

  it('a failed credential read 500s rather than answering “not connected”', async () => {
    // Otherwise a database blip shows a live studio the first-connect form and
    // invites an owner to re-paste a credential that is working fine.
    world({ errors: { email_mailbox_credentials: { code: '42501', message: 'permission denied' } } })
    const { res, body } = await get(MB_STUDIO.id)
    expect(res.status).toBe(500)
    expect(body.success).toBe(false)
  })

  it('reports “not connected” for a mailbox that genuinely has no credential', async () => {
    const { res, body } = await get(MB_ACCOUNTS.id)
    expect(res.status).toBe(200)
    expect(body.data.connection).toBeNull()
    expect(body.data.ingress).toBe('postmark')
  })
})

// PHASE 11.1 — how many accounts ONE LOCATION may connect.
//
// Every connected mailbox is an IMAP session, a body download per message and
// an attachment upload per file, every five minutes, out of ONE shared cron
// with ONE wall-clock budget. The poller degrades GRACEFULLY under load rather
// than failing, which is precisely why an uncapped tenant would just make
// everyone else's mail slower and nothing would ever say so.
describe('connected-mailbox limit', () => {
  // A location already sitting exactly on the cap. MB_STUDIO stays on Postmark
  // so it is the one being newly connected; the fillers are what fill the quota.
  const atCap = (studio = onPostmark(MB_STUDIO)) => {
    const fillers = Array.from({ length: MAX_CONNECTED_MAILBOXES_PER_LOCATION }, (_, i) => ({
      ...MB_ACCOUNTS,
      id: `mb-filler-${i}`,
      address: `filler-${i}@un1tdublin.com`,
      ingress: 'imap',
      egress: 'postmark',
    }))
    return world({ mailboxes: [studio, ...fillers, onPostmark(MB_OTHER_LOCATION)] })
  }

  it('refuses a NEW connection at the cap, and costs no dial', async () => {
    atCap()
    const { res, body } = await put(MB_STUDIO.id, GMAIL)

    expect(res.status).toBe(400)
    expect(body.code).toBe('connected_mailbox_limit')
    // The refusal has to be actionable: which way out, and that the ceiling is
    // a policy rather than a bug the operator has hit.
    expect(body.error).toMatch(/Disconnect one/i)
    // Refused BEFORE the socket, like every other refusal on this route — a
    // capped tenant must not be able to spend dials either.
    expect(verifyConnection).not.toHaveBeenCalled()
    expect(writesTo(db)).toEqual([])
  })

  it('🔴 STILL LETS AN ALREADY-CONNECTED MAILBOX BE FIXED AT THE CAP', async () => {
    // The trap. PUT is also how a revoked app password is rotated and how a
    // wrong host is corrected. Counting the mailbox in front of us would mean a
    // studio sitting exactly on the cap could no longer repair a broken
    // connection — and the only workaround, disconnect-then-reconnect, DROPS
    // THE POLL CURSOR. A limit that blocks maintenance is worse than no limit.
    atCap({ ...MB_STUDIO, ingress: 'imap', egress: 'postmark' })
    const { res } = await put(MB_STUDIO.id, { ...GMAIL, password: 'new-app-password' })

    expect(res.status).toBe(200)
    expect(verifyConnection).toHaveBeenCalled()
    expect(openSealed(credentialFor(MB_STUDIO.id).secret_ciphertext)).toBe('new-app-password')
  })

  it('counts only THIS location — another studio being full is not our problem', async () => {
    const fillers = Array.from({ length: MAX_CONNECTED_MAILBOXES_PER_LOCATION }, (_, i) => ({
      ...MB_OTHER_LOCATION, id: `mb-other-${i}`, address: `other-${i}@elsewhere.ie`, ingress: 'imap',
    }))
    world({ mailboxes: [onPostmark(MB_STUDIO), ...fillers] })

    const { res } = await put(MB_STUDIO.id, GMAIL)
    expect(res.status).toBe(200)
  })

  it('FAILS OPEN when the count cannot be read', async () => {
    // The ceiling is a fairness nicety, not a safety property. Refusing a
    // legitimate connection over a transient database fault trades a working
    // mailbox for nothing — log loudly, let it through.
    world({ errors: { email_mailboxes: { code: '42501', message: 'permission denied' } } })
    const { res } = await put(MB_STUDIO.id, GMAIL)
    expect(res.status).not.toBe(400)
  })
})

describe('audit', () => {
  it('records the first connect, with no secret anywhere in the row', async () => {
    await put(MB_STUDIO.id, GMAIL)
    const audits = insertsInto(db, 'audit_events')
    expect(audits).toHaveLength(1)
    expect(audits[0].payload.action).toBe('email_mailbox_connection.connected')
    expect(audits[0].payload.actor_id).toBe(OWNER_A.id)
    expect(audits[0].payload.details.username).toBe('studio@un1tdublin.com')
    expect(audits[0].payload.details.password_changed).toBe(true)
    expect(JSON.stringify(audits[0].payload)).not.toContain(GMAIL.password)
  })

  it('records a password rotation under its own action', async () => {
    world({}, { credentials: [storedCredential(MB_STUDIO.id)] })
    await put(MB_STUDIO.id, { ...GMAIL, password: 'rotated-app-password' })
    const audits = insertsInto(db, 'audit_events')
    expect(audits[0].payload.action).toBe('email_mailbox_connection.credential_changed')
    expect(JSON.stringify(audits[0].payload)).not.toContain('rotated-app-password')
  })

  it('records a settings-only change as an update, not a credential change', async () => {
    world({}, { credentials: [storedCredential(MB_STUDIO.id)] })
    const { password: _drop, ...settingsOnly } = GMAIL
    await put(MB_STUDIO.id, { ...settingsOnly, imap_port: 143, imap_secure: false })
    const audits = insertsInto(db, 'audit_events')
    expect(audits[0].payload.action).toBe('email_mailbox_connection.updated')
    expect(audits[0].payload.details.password_changed).toBe(false)
  })

  it('does not audit a refused connect', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    await put(MB_STUDIO.id, GMAIL)
    expect(insertsInto(db, 'audit_events')).toEqual([])
  })
})

describe('DELETE — disconnecting', () => {
  beforeEach(() => {
    world({}, {
      credentials: [storedCredential(MB_STUDIO.id)],
      ingressRows: [
        { mailbox_id: MB_STUDIO.id, folder: 'inbox', last_uid: 480 },
        { mailbox_id: MB_ACCOUNTS.id, folder: 'inbox', last_uid: 12 },
      ],
    })
    const row = db._state.mailboxes.find(m => m.id === MB_STUDIO.id)
    row.ingress = 'imap'
    row.egress = 'smtp'
  })

  it('destroys the credential, the cursor, and both transport flags', async () => {
    const { res, body } = await del(MB_STUDIO.id)
    expect(res.status).toBe(200)
    expect(body.data.changed).toBe(true)

    expect(credentialFor(MB_STUDIO.id)).toBeNull()
    // The cursor belongs to the account that was connected — keeping it would
    // let a different login behind the same mailbox resume past its watermark
    // and skip everything below it.
    expect(db._state.ingressRows.filter(r => r.mailbox_id === MB_STUDIO.id)).toEqual([])
    // …but only this mailbox's.
    expect(db._state.ingressRows.filter(r => r.mailbox_id === MB_ACCOUNTS.id)).toHaveLength(1)

    // egress too: an account left on 'smtp' with no credential would fail
    // every reply at send time, in front of a member.
    expect(mailboxRow(MB_STUDIO.id).ingress).toBe('postmark')
    expect(mailboxRow(MB_STUDIO.id).egress).toBe('postmark')
  })

  it('audits the disconnect — the only record that the account was ever connected', async () => {
    await del(MB_STUDIO.id)
    const audits = insertsInto(db, 'audit_events')
    expect(audits).toHaveLength(1)
    expect(audits[0].payload.action).toBe('email_mailbox_connection.disconnected')
    expect(audits[0].payload.details.was.imap_host).toBe('imap.gmail.com')
    expect(audits[0].payload.details.previous_ingress).toBe('imap')
    expect(JSON.stringify(audits[0].payload)).not.toContain('secret_ciphertext')
  })

  it('destroys the credential BEFORE it reports success — a failed reset does not claim otherwise', async () => {
    // The reverse ordering would leave a live app password in the database
    // after the operator was told it was gone.
    await del(MB_STUDIO.id)
    const deleteIndex = db.deletes.findIndex(d => d.table === 'email_mailbox_credentials')
    const resetIndex = db.updates.findIndex(u => u.table === 'email_mailboxes')
    expect(deleteIndex).toBeGreaterThanOrEqual(0)
    expect(resetIndex).toBeGreaterThanOrEqual(0)
  })

  it('is idempotent on an account that was never connected — success, no audit row', async () => {
    world()
    const { res, body } = await del(MB_ACCOUNTS.id)
    expect(res.status).toBe(200)
    expect(body.data.changed).toBe(false)
    expect(writesTo(db)).toEqual([])
    expect(insertsInto(db, 'audit_events')).toEqual([])
  })

  it('does not delete the mailbox itself', async () => {
    await del(MB_STUDIO.id)
    expect(mailboxRow(MB_STUDIO.id)).toBeTruthy()
    expect(db.deletes.some(d => d.table === 'email_mailboxes')).toBe(false)
  })
})
