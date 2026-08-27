// MAILBOX-CONNECT.7 — SMTP transport tests, against a FAKE transporter.
//
// Nothing here touches the network. `sendViaSmtp` and `verifySmtpConnection`
// take an optional `{ createTransport, db }` seam for exactly that reason, and
// the seam is what makes the properties that actually matter testable:
//
//   • the From is the mailbox address and NEVER falls back to a domain we own
//   • the verdict envelope is byte-compatible with the Postmark path, always,
//     including on every one of the four ways the credential can be unusable
//   • the mailbox password never appears in anything we return or log
//   • nodemailer is handed the shapes it actually reads (the XOAUTH2 `type`
//     key, `{ key, value }` headers) rather than the ones the cross-phase
//     contract assumed
//
// The credential goes through the REAL secret-box + auth-strategy rather than
// a stub. Those two are the OAuth seam; a stub here would test that this file
// calls a function, when the thing worth pinning is that a sealed password
// reaches nodemailer's `auth.pass` intact and a sealed OAuth token does not
// reach it at all.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  sendViaSmtp,
  verifySmtpConnection,
  adaptAuthForNodemailer,
  toNodemailerHeaders,
  toNodemailerAttachments,
  safeSmtpError,
  bareMessageId,
} from './smtp-send'
import { seal } from './secret-box'
// The REAL inbound parser, not a copy of it. The round-trip test below is only
// worth anything if it runs against the code the webhook actually uses.
import { extractCandidateMessageIds } from '@/lib/email-inbox'

// A real 32-byte key, base64. The tests seal with it and let auth-strategy
// open with it, so the whole credential path is exercised for real.
const KEY = Buffer.alloc(32, 7).toString('base64')

const MAILBOX = Object.freeze({
  id: 'mb-1',
  address: 'hello@theirgym.ie',
  egress: 'smtp',
})

const APP_PASSWORD = 'not-a-real-app-password'

const SEND = Object.freeze({
  to: 'member@example.com',
  subject: 'Re: Class times',
  htmlBody: '<div>We open at 6.</div>',
  textBody: 'We open at 6.',
})

/** A credential row as PostgREST would hand it back. */
function credentialRow(overrides = {}) {
  return {
    mailbox_id: MAILBOX.id,
    auth_type: 'password',
    username: 'hello@theirgym.ie',
    secret_ciphertext: seal(APP_PASSWORD),
    oauth_access_token_ciphertext: null,
    oauth_expires_at: null,
    smtp_host: 'smtp.gmail.com',
    smtp_port: 465,
    smtp_secure: true,
    ...overrides,
  }
}

/**
 * The narrowest possible stand-in for the supabase builder: a thenable chain
 * that records what was selected and filtered so the tests can assert the
 * query as well as the outcome.
 */
function fakeDb({ row = credentialRow(), error = null, throws = false } = {}) {
  const calls = { table: null, columns: null, filters: [] }
  const builder = {
    select(columns) { calls.columns = columns; return builder },
    eq(col, val) { calls.filters.push([col, val]); return builder },
    async maybeSingle() {
      if (throws) throw new Error('supabase is down')
      return { data: row, error }
    },
  }
  return {
    calls,
    from(table) { calls.table = table; return builder },
  }
}

/**
 * A stand-in for a nodemailer transporter. Records the options it was built
 * with and every message handed to it, so the assertions can be about the
 * CONVERSATION rather than the return value.
 */
function fakeTransport(opts = {}) {
  const { info, sendError, verifyError } = opts
  // Key PRESENCE, not truthiness: the "never throws" group deliberately throws
  // `null` and other falsy junk, and a fake that quietly succeeded on those
  // would be testing nothing at exactly the point it matters most.
  const sendThrows = Object.prototype.hasOwnProperty.call(opts, 'sendError')
  const verifyThrows = Object.prototype.hasOwnProperty.call(opts, 'verifyError')
  const made = []
  const sent = []
  let closed = 0
  return {
    made,
    sent,
    get closed() { return closed },
    deps: {
      createTransport: (opts) => {
        made.push(opts)
        return {
          async sendMail(message) {
            sent.push(message)
            if (sendThrows) throw sendError
            return info || {
              messageId: '<generated@theirgym.ie>',
              accepted: ['member@example.com'],
              rejected: [],
              response: '250 2.0.0 OK  1756200000 abc.42 - gsmtp',
            }
          },
          async verify() {
            if (verifyThrows) throw verifyError
            return true
          },
          close() { closed += 1 },
        }
      },
    },
  }
}

beforeEach(() => {
  process.env.MAILBOX_SECRET_KEY = KEY
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.MAILBOX_SECRET_KEY
})

/* ──────────────────── the From never falls back ───────────────────── */
//
// THE MOST IMPORTANT GROUP IN THIS FILE. On the Postmark path a From that
// cannot be sent from degrades to a domain we own, with Reply-To pointing back
// — correct there, because the refusal happens at submit time and nothing was
// transmitted. Here there is no such refusal to catch: SMTP authenticates AS
// an account, and a substituted From would put OUR domain on a reply the
// member expects from THEIRS. So the address is the mailbox's or the send does
// not happen, and no failure mode may quietly turn that into a second attempt.
describe('the From is the mailbox address, or nothing', () => {
  it('sends AS the mailbox address', async () => {
    const t = fakeTransport()
    const res = await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db: fakeDb(), ...t.deps })

    expect(res.ok).toBe(true)
    expect(t.sent[0].from).toBe('hello@theirgym.ie')
    expect(res.fromEmail).toBe('hello@theirgym.ie')
  })

  it('never degrades — `degraded` is null on every successful SMTP send', async () => {
    const t = fakeTransport()
    const res = await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db: fakeDb(), ...t.deps })
    expect(res.degraded).toBeNull()
  })

  it('never puts POSTMARK_FROM_EMAIL anywhere near the message', async () => {
    process.env.POSTMARK_FROM_EMAIL = 'UN1T <hello@un1t.ie>'
    const t = fakeTransport()
    await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db: fakeDb(), ...t.deps })
    expect(JSON.stringify(t.sent[0])).not.toContain('un1t.ie')
    delete process.env.POSTMARK_FROM_EMAIL
  })

  it('a send failure is reported, NOT retried from another address', async () => {
    // The Postmark path retries once on a sender-signature rejection. If that
    // behaviour ever leaked into this one, the second attempt would show up
    // here as a second sendMail with a different From.
    const t = fakeTransport({ sendError: Object.assign(new Error('Invalid login'), { code: 'EAUTH' }) })
    const res = await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db: fakeDb(), ...t.deps })

    expect(res).toMatchObject({ ok: false, reason: 'send_failed' })
    expect(t.sent).toHaveLength(1)
  })

  it('refuses rather than substituting when the mailbox has no address', async () => {
    const t = fakeTransport()
    const res = await sendViaSmtp(
      { mailbox: { id: 'mb-1', address: '  ', egress: 'smtp' }, ...SEND },
      { db: fakeDb(), ...t.deps }
    )
    expect(res).toMatchObject({ ok: false, reason: 'not_configured' })
    expect(t.sent).toHaveLength(0)
  })

  it('sets no Reply-To — the From already is the mailbox', async () => {
    const t = fakeTransport()
    await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db: fakeDb(), ...t.deps })
    expect(t.sent[0].replyTo).toBeUndefined()
  })
})

/* ─────────────────────── the verdict envelope ─────────────────────── */
//
// sendTicketEmail's three routes branch on `reason` — 503 for not_configured,
// 400 for send_failed — and neither of them knows a second transport exists.
// So every exit from this module has to land in one of those two buckets, and
// the bucket has to mean what the route thinks it means.
describe('the verdict envelope matches the Postmark path', () => {
  it('success carries result, fromEmail and degraded', async () => {
    const t = fakeTransport()
    const res = await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db: fakeDb(), ...t.deps })
    expect(Object.keys(res).sort()).toEqual(
      ['degraded', 'deliveryTracked', 'fromEmail', 'ok', 'result'].sort()
    )
  })

  it('an unconnected mailbox is `not_configured` — 503, nothing attempted', async () => {
    const t = fakeTransport()
    const res = await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db: fakeDb({ row: null }), ...t.deps })
    expect(res).toMatchObject({ ok: false, reason: 'not_configured' })
    expect(res.error).toMatch(/no mail account is connected/i)
    expect(t.sent).toHaveLength(0)
  })

  it('a mailbox with no SMTP host is `not_configured`, and says which half is missing', async () => {
    const t = fakeTransport()
    const db = fakeDb({ row: credentialRow({ smtp_host: null }) })
    const res = await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db, ...t.deps })
    expect(res).toMatchObject({ ok: false, reason: 'not_configured' })
    expect(res.error).toMatch(/outgoing \(SMTP\) server/i)
    expect(t.sent).toHaveLength(0)
  })

  it('a FAILED credential lookup is not read as "unconnected"', async () => {
    // The CLAUDE.md .single() invariant: "the query failed" and "there is no
    // row" arrive as the same `data === null`, and telling an operator to go
    // connect a mailbox that is already connected sends them to a screen that
    // is correct and leaves them with no idea what happened.
    const t = fakeTransport()
    const db = fakeDb({ row: null, error: { message: 'timeout' } })
    const res = await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db, ...t.deps })
    expect(res).toMatchObject({ ok: false, reason: 'not_configured' })
    expect(res.error).toMatch(/try again/i)
    expect(res.error).not.toMatch(/no mail account is connected/i)
  })

  it('a THROWING database client still produces a verdict', async () => {
    const t = fakeTransport()
    const res = await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db: fakeDb({ throws: true }), ...t.deps })
    expect(res).toMatchObject({ ok: false, reason: 'not_configured' })
  })

  it('carries auth-strategy’s own sentence for an undecryptable credential', async () => {
    const t = fakeTransport()
    const db = fakeDb({ row: credentialRow({ secret_ciphertext: 'v1:AAAA:BBBB:CCCC' }) })
    const res = await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db, ...t.deps })
    // decrypt_failed is a stored-configuration fault: nothing was attempted,
    // so it maps onto not_configured rather than widening the envelope.
    expect(res).toMatchObject({ ok: false, reason: 'not_configured' })
    expect(res.error).toMatch(/could not be decrypted/i)
    expect(t.sent).toHaveLength(0)
  })

  it('never throws, whatever the transport does', async () => {
    for (const boom of [new Error('ECONNREFUSED'), 'a string', null, { weird: true }]) {
      const t = fakeTransport({ sendError: boom })
      const res = await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db: fakeDb(), ...t.deps })
      expect(res.ok).toBe(false)
      expect(res.reason).toBe('send_failed')
    }
  })

  it('reports a failure when every recipient was rejected', async () => {
    const t = fakeTransport({ info: { messageId: '<x@y>', accepted: [], rejected: ['member@example.com'] } })
    const res = await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db: fakeDb(), ...t.deps })
    expect(res).toMatchObject({ ok: false, reason: 'send_failed' })
  })

  it('a PARTIAL rejection still succeeds — the accepted recipients have it', async () => {
    const t = fakeTransport({
      info: { messageId: '<x@y>', accepted: ['a@example.com'], rejected: ['b@example.com'], response: '250 ok' },
    })
    const res = await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db: fakeDb(), ...t.deps })
    expect(res.ok).toBe(true)
    expect(res.result.rejected).toEqual(['b@example.com'])
  })
})

/* ──────────────────── credentials never leak out ──────────────────── */
describe('the mailbox password never leaves this module', () => {
  it('is not in the error when the server echoes it back', async () => {
    // Some servers quote the AUTH argument in their rejection. This string is
    // returned to the route, rendered to an operator, and screenshotted.
    const sendError = new Error(`535 Bad credentials for ${APP_PASSWORD}`)
    const t = fakeTransport({ sendError })
    const res = await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db: fakeDb(), ...t.deps })

    expect(res.ok).toBe(false)
    expect(res.error).not.toContain(APP_PASSWORD)
    expect(res.error).toContain('[redacted]')
  })

  it('is not in the error when nodemailer attaches it to `response`', async () => {
    const sendError = Object.assign(new Error('Invalid login'), {
      response: `535-5.7.8 Username and Password not accepted: ${APP_PASSWORD}`,
      code: 'EAUTH',
    })
    const t = fakeTransport({ sendError })
    const res = await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db: fakeDb(), ...t.deps })
    expect(res.error).not.toContain(APP_PASSWORD)
  })

  it('the returned verdict contains no ciphertext and no plaintext anywhere', async () => {
    const row = credentialRow()
    const t = fakeTransport()
    const res = await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db: fakeDb({ row }), ...t.deps })
    const dump = JSON.stringify(res)
    expect(dump).not.toContain(APP_PASSWORD)
    expect(dump).not.toContain(row.secret_ciphertext)
  })

  it('caps a pathological server response rather than storing all of it', () => {
    expect(safeSmtpError(new Error('x'.repeat(5000))).length).toBe(500)
  })

  it('leaves a short secret alone rather than shredding the message', () => {
    // Scrubbing a 3-character value would turn every message containing those
    // letters into confetti; the operator loses the diagnosis and gains nothing.
    expect(safeSmtpError(new Error('no such user'), { pass: 'us' })).toBe('no such user')
  })

  it('never logs the SMTP conversation — the AUTH line carries the password', async () => {
    const t = fakeTransport()
    await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db: fakeDb(), ...t.deps })
    expect(t.made[0].logger).toBe(false)
    expect(t.made[0].debug).toBe(false)
  })
})

/* ───────────────── delivery status is not tracked ─────────────────── */
//
// mig 498's NULL delivery_status means "sent, and we have heard nothing". On
// this path it means something stronger and permanent — no Postmark webhook
// can ever arrive — and the difference is what stops the thread rendering an
// event that is never going to resolve.
describe('delivery is honestly untracked', () => {
  it('flags the send as untracked', async () => {
    const t = fakeTransport()
    const res = await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db: fakeDb(), ...t.deps })
    expect(res.deliveryTracked).toBe(false)
  })

  it('leaves `messageId` NULL so no Postmark correlation key is invented', async () => {
    // The routes write result.messageId straight into
    // email_inbox_messages.postmark_message_id — Postmark's own GUID and the
    // key its webhooks are looked up by. An SMTP id in that column would claim
    // a correlation that cannot exist and occupy a UNIQUE index for nothing.
    const t = fakeTransport()
    const res = await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db: fakeDb(), ...t.deps })
    expect(res.result.messageId).toBeNull()
  })

  // AUDIT FIX — this test used to assert the BRACKETED form, which is what
  // nodemailer returns and what the code stored. That was the bug: the inbound
  // webhook matches rfc_message_id with plain string equality against
  // bracket-STRIPPED candidates (parseMessageIdTokens), and every inbound row
  // is stored bare via extractRfcMessageId. Storing `<x@y>` matched neither
  // that column nor postmark_message_id (NULL on SMTP by design), so every
  // customer reply to an SMTP-sent message opened a new ticket while the
  // original sat unanswered. The test pinned the defect in place.
  it('returns the RFC Message-ID BARE, which is the form threading matches on', async () => {
    const t = fakeTransport()
    const res = await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db: fakeDb(), ...t.deps })
    expect(res.result.rfcMessageId).toBe('generated@theirgym.ie')
    expect(res.result.rfcMessageId).not.toContain('<')
    expect(res.result.rfcMessageId).not.toContain('>')
  })

  it('round-trips against the inbound parser, which is the actual contract', async () => {
    // The real assertion is not "no brackets", it is "the value we store is the
    // value the webhook will look for". Prove it against the inbound helpers
    // themselves rather than against a hand-written expectation.
    const t = fakeTransport()
    const res = await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db: fakeDb(), ...t.deps })
    const stored = res.result.rfcMessageId

    // What a recipient's client puts on its reply, and what the webhook
    // extracts from it to match against email_inbox_messages.rfc_message_id.
    const candidates = extractCandidateMessageIds([
      { Name: 'In-Reply-To', Value: `<${stored}>` },
    ])
    expect(candidates).toContain(stored)
  })

  describe('bareMessageId', () => {
    it('strips brackets, tolerates the bare form, and rejects junk', () => {
      expect(bareMessageId('<a@b.com>')).toBe('a@b.com')
      expect(bareMessageId('  <a@b.com>  ')).toBe('a@b.com')
      expect(bareMessageId('a@b.com')).toBe('a@b.com')
      expect(bareMessageId('')).toBeNull()
      expect(bareMessageId('   ')).toBeNull()
      expect(bareMessageId(null)).toBeNull()
      expect(bareMessageId(undefined)).toBeNull()
      expect(bareMessageId(123)).toBeNull()
      expect(bareMessageId('<>')).toBeNull()
    })
  })

  it('records the submission server’s own response line', async () => {
    const t = fakeTransport()
    const res = await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db: fakeDb(), ...t.deps })
    expect(res.result.response).toMatch(/^250 /)
  })
})

/* ─────────────────── what nodemailer actually reads ───────────────── */
describe('the message handed to nodemailer', () => {
  it('passes to/cc/bcc through as the wire strings they arrived as', async () => {
    const t = fakeTransport()
    await sendViaSmtp({
      mailbox: MAILBOX,
      ...SEND,
      to: 'a@example.com, b@example.com',
      cc: 'c@example.com',
      bcc: 'd@example.com',
    }, { db: fakeDb(), ...t.deps })

    expect(t.sent[0].to).toBe('a@example.com, b@example.com')
    expect(t.sent[0].cc).toBe('c@example.com')
    expect(t.sent[0].bcc).toBe('d@example.com')
  })

  it('puts a bcc address in `bcc` and NOWHERE else', async () => {
    const t = fakeTransport()
    await sendViaSmtp({
      mailbox: MAILBOX, ...SEND, bcc: 'secret@example.com',
      headers: [{ Name: 'In-Reply-To', Value: '<x@y>' }],
    }, { db: fakeDb(), ...t.deps })

    const { bcc, ...rest } = t.sent[0]
    expect(bcc).toBe('secret@example.com')
    expect(JSON.stringify(rest)).not.toContain('secret@example.com')
  })

  it('sends both bodies, so the member gets the same message either transport', async () => {
    const t = fakeTransport()
    await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db: fakeDb(), ...t.deps })
    expect(t.sent[0].text).toBe('We open at 6.')
    expect(t.sent[0].html).toBe('<div>We open at 6.</div>')
  })

  it('reads the credential row with an explicit column list, filtered to the mailbox', async () => {
    const t = fakeTransport()
    const db = fakeDb()
    await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db, ...t.deps })
    expect(db.calls.table).toBe('email_mailbox_credentials')
    expect(db.calls.columns).not.toBe('*')
    expect(db.calls.columns).toContain('smtp_host')
    expect(db.calls.filters).toEqual([['mailbox_id', 'mb-1']])
  })

  it('carries the credential’s host, port and TLS setting', async () => {
    const t = fakeTransport()
    const db = fakeDb({ row: credentialRow({ smtp_host: 'mail.custom.ie', smtp_port: 587, smtp_secure: false }) })
    await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db, ...t.deps })

    expect(t.made[0].host).toBe('mail.custom.ie')
    expect(t.made[0].port).toBe(587)
    expect(t.made[0].secure).toBe(false)
  })

  it('DEMANDS STARTTLS whenever implicit TLS is off', async () => {
    // Without this, nodemailer upgrades only if the server offers it and
    // otherwise sends the member's correspondence — and the mailbox password —
    // in the clear, while reporting a completely successful send.
    const t = fakeTransport()
    const db = fakeDb({ row: credentialRow({ smtp_port: 587, smtp_secure: false }) })
    await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db, ...t.deps })
    expect(t.made[0].requireTLS).toBe(true)
  })

  it('treats an absent `smtp_secure` as implicit TLS, never as cleartext', async () => {
    const t = fakeTransport()
    const db = fakeDb({ row: credentialRow({ smtp_secure: undefined }) })
    await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db, ...t.deps })
    expect(t.made[0].secure).toBe(true)
  })

  it('hands nodemailer the decrypted password on `auth.pass`', async () => {
    const t = fakeTransport()
    await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db: fakeDb(), ...t.deps })
    expect(t.made[0].auth).toEqual({ user: 'hello@theirgym.ie', pass: APP_PASSWORD })
  })

  it('always releases the connection, on success and on failure alike', async () => {
    const ok = fakeTransport()
    await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db: fakeDb(), ...ok.deps })
    expect(ok.closed).toBe(1)

    const bad = fakeTransport({ sendError: new Error('nope') })
    await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db: fakeDb(), ...bad.deps })
    expect(bad.closed).toBe(1)
  })
})

/* ───────────────────────── header mapping ─────────────────────────── */
//
// Threading is the whole reason In-Reply-To and References are on the message.
// Postmark's `[{Name, Value}]` and nodemailer's `[{key, value}]` look alike
// enough that handing one to the other produces no error at all — just a
// message with no threading anchors, which starts a fresh thread in the
// member's client and opens a duplicate ticket when they reply.
describe('threading headers survive the transport swap', () => {
  it('maps Name/Value onto key/value', () => {
    expect(toNodemailerHeaders([
      { Name: 'In-Reply-To', Value: '<inbound-1@mail.example.com>' },
      { Name: 'References', Value: '<a@x> <inbound-1@mail.example.com>' },
    ])).toEqual([
      { key: 'In-Reply-To', value: '<inbound-1@mail.example.com>' },
      { key: 'References', value: '<a@x> <inbound-1@mail.example.com>' },
    ])
  })

  it('drops an entry with no usable name rather than adding an empty header', () => {
    expect(toNodemailerHeaders([{ Value: 'orphan' }, { Name: '  ' }])).toBeUndefined()
  })

  it('is undefined for no headers, so nodemailer adds none', () => {
    expect(toNodemailerHeaders(undefined)).toBeUndefined()
    expect(toNodemailerHeaders([])).toBeUndefined()
  })

  it('reaches the message when a reply carries them', async () => {
    const t = fakeTransport()
    await sendViaSmtp({
      mailbox: MAILBOX, ...SEND,
      headers: [{ Name: 'In-Reply-To', Value: '<inbound-1@mail.example.com>' }],
    }, { db: fakeDb(), ...t.deps })

    expect(t.sent[0].headers).toEqual([
      { key: 'In-Reply-To', value: '<inbound-1@mail.example.com>' },
    ])
  })
})

/* ─────────────────────── attachment mapping ───────────────────────── */
describe('attachments cross field by field, never by spread', () => {
  it('maps Postmark’s three fields onto nodemailer’s', () => {
    expect(toNodemailerAttachments([
      { Name: 'invoice.pdf', Content: 'aGVsbG8=', ContentType: 'application/pdf' },
    ])).toEqual([
      { filename: 'invoice.pdf', content: 'aGVsbG8=', encoding: 'base64', contentType: 'application/pdf' },
    ])
  })

  it('drops `path` and `href` — nodemailer would READ or FETCH them', () => {
    // A spread would turn any future path where a user can influence an
    // attachment object into local-file exfiltration or SSRF, with the bytes
    // attached to an email whose recipient the attacker chose.
    const mapped = toNodemailerAttachments([{
      Name: 'ok.txt', Content: 'aGk=', ContentType: 'text/plain',
      path: '/etc/passwd', href: 'http://169.254.169.254/latest/meta-data/',
    }])
    expect(mapped[0]).not.toHaveProperty('path')
    expect(mapped[0]).not.toHaveProperty('href')
  })

  it('is undefined when there are none, so the message is unchanged', () => {
    expect(toNodemailerAttachments(undefined)).toBeUndefined()
    expect(toNodemailerAttachments([])).toBeUndefined()
  })

  it('rides along on a real send', async () => {
    const t = fakeTransport()
    await sendViaSmtp({
      mailbox: MAILBOX, ...SEND,
      attachments: [{ Name: 'a.pdf', Content: 'aGk=', ContentType: 'application/pdf' }],
    }, { db: fakeDb(), ...t.deps })
    expect(t.sent[0].attachments).toHaveLength(1)
    expect(t.sent[0].attachments[0].encoding).toBe('base64')
  })
})

/* ────────────────────── the XOAUTH2 correction ────────────────────── */
//
// 🔴 The cross-phase contract claimed nodemailer accepts `{ user, accessToken }`
// verbatim, the way imapflow does. It does not: lib/smtp-transport/index.js
// getAuth() switches on `authData.type`, and only 'OAUTH2' builds the XOAuth2
// helper that smtp-connection's login() looks for. Verified against 9.0.5's
// source AND by construction — `new SMTPTransport({ auth: { user,
// accessToken } })` resolves to `{ type: 'LOGIN', credentials: { user } }`,
// with the token dropped, which fails at login with EAUTH.
//
// The adaptation lives here rather than in auth-strategy.js so that module's
// verdict stays transport-neutral — it is shared with imapflow, which reads
// the bare shape and would have to strip a `type` key back off.
describe('adaptAuthForNodemailer', () => {
  it('adds the `type` key nodemailer selects XOAUTH2 from', () => {
    expect(adaptAuthForNodemailer({ user: 'a@b.com', accessToken: 'ya29.TOKEN' }))
      .toEqual({ type: 'OAuth2', user: 'a@b.com', accessToken: 'ya29.TOKEN' })
  })

  it('leaves the password shape untouched — nodemailer already reads it', () => {
    const auth = { user: 'a@b.com', pass: 'secret-pw' }
    expect(adaptAuthForNodemailer(auth)).toBe(auth)
  })

  it('does not invent an OAuth2 shape from an empty token', () => {
    expect(adaptAuthForNodemailer({ user: 'a@b.com', accessToken: '' }))
      .toEqual({ user: 'a@b.com', accessToken: '' })
  })

  it('an oauth credential row reaches nodemailer as OAuth2, not as a password', async () => {
    const t = fakeTransport()
    const db = fakeDb({
      row: credentialRow({
        auth_type: 'oauth',
        secret_ciphertext: null,
        oauth_access_token_ciphertext: seal('ya29.LIVE-TOKEN'),
        oauth_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    })
    await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db, ...t.deps })

    expect(t.made[0].auth).toEqual({
      type: 'OAuth2', user: 'hello@theirgym.ie', accessToken: 'ya29.LIVE-TOKEN',
    })
    // The one that would have been silent: a token landing on `pass` means an
    // OAuth credential being offered to a plain LOGIN command.
    expect(t.made[0].auth.pass).toBeUndefined()
  })

  it('an expired OAuth token refuses the send rather than trying it', async () => {
    const t = fakeTransport()
    const db = fakeDb({
      row: credentialRow({
        auth_type: 'oauth',
        secret_ciphertext: null,
        oauth_access_token_ciphertext: seal('ya29.SPENT'),
        oauth_expires_at: new Date(Date.now() - 1000).toISOString(),
      }),
    })
    const res = await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db, ...t.deps })
    expect(res).toMatchObject({ ok: false, reason: 'not_configured' })
    expect(t.sent).toHaveLength(0)
  })
})

/* ────────────────────── verifySmtpConnection ──────────────────────── */
//
// Phase 6 verifies BEFORE persisting a credential: an inbox that cannot log in
// is worse than no inbox, because it sits there failing in silence. The person
// on the other end is typing a password into a form, so this returns a verdict
// rather than throwing — "535 Username and Password not accepted" is something
// they can act on and a 500 is not.
describe('verifySmtpConnection', () => {
  it('is ok when the server accepts the credential', async () => {
    const t = fakeTransport()
    const res = await verifySmtpConnection(
      { host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: 'a@b.com', pass: APP_PASSWORD } },
      t.deps
    )
    expect(res).toEqual({ ok: true })
  })

  it('returns the server’s own words on a rejection, never throws', async () => {
    const t = fakeTransport({
      verifyError: Object.assign(new Error('Invalid login'), {
        response: '535-5.7.8 Username and Password not accepted', code: 'EAUTH',
      }),
    })
    const res = await verifySmtpConnection(
      { host: 'smtp.gmail.com', auth: { user: 'a@b.com', pass: APP_PASSWORD } },
      t.deps
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain('535-5.7.8')
  })

  it('redacts the password from the rejection', async () => {
    const t = fakeTransport({ verifyError: new Error(`bad password: ${APP_PASSWORD}`) })
    const res = await verifySmtpConnection(
      { host: 'smtp.gmail.com', auth: { user: 'a@b.com', pass: APP_PASSWORD } },
      t.deps
    )
    expect(res.error).not.toContain(APP_PASSWORD)
  })

  it('refuses with no host rather than dialling nothing', async () => {
    const t = fakeTransport()
    const res = await verifySmtpConnection({ host: '', auth: { user: 'a@b.com', pass: 'x' } }, t.deps)
    expect(res.ok).toBe(false)
    expect(t.made).toHaveLength(0)
  })

  it('always releases the socket', async () => {
    const t = fakeTransport({ verifyError: new Error('nope') })
    await verifySmtpConnection({ host: 'smtp.gmail.com', auth: { user: 'a@b.com', pass: 'x' } }, t.deps)
    expect(t.closed).toBe(1)
  })
})

/* ══════════ MAILBOX-OAUTH.5 — refresh before send ══════════════════ */
//
// `sendViaSmtp` swapped `resolveAuth(credential)` for
// `await resolveFreshAuth(db, credential)`. Two things have to be true of that
// and they pull in opposite directions:
//
//   • An OAuth mailbox that has been idle past its token's lifetime must get a
//     RENEWAL, not a refusal. An operator hitting Send is watching a spinner,
//     and "the sign-in expired" is a refusal they can do nothing about.
//   • 🔴 A PASSWORD MAILBOX MUST BE COMPLETELY UNAFFECTED. Every mailbox in
//     production today is one, so this is the regression that would hurt most:
//     it would hurt on the path that carries a member's reply.
//
// The token endpoint is stubbed at globalThis.fetch, because that is where
// resolveFreshAuth reaches — `createTransport` is the SMTP seam and is a
// different one. Unstubbed, these would call login.microsoftonline.com.
describe('MAILBOX-OAUTH.5 — the send path renews before it dials', () => {
  const OAUTH_ENV = {
    MAILBOX_OAUTH_MICROSOFT_CLIENT_ID: 'the-client-id',
    MAILBOX_OAUTH_MICROSOFT_CLIENT_SECRET: 'the-client-secret',
  }

  /**
   * The credential fake above answers reads only. resolveFreshAuth also
   * PERSISTS a rotated token, so this one records updates as well — otherwise
   * "the send worked" would be proven while the write that keeps the NEXT send
   * working was silently missing.
   */
  function fakeDbWithWrites(row) {
    const updates = []
    return {
      updates,
      from() {
        const b = {
          _filters: [],
          select() { return b },
          eq(col, val) { b._filters.push([col, val]); return b },
          async maybeSingle() { return { data: row, error: null } },
          update(payload) {
            const u = {
              _f: [],
              eq(col, val) { u._f.push([col, val]); return u },
              then(res, rej) {
                updates.push({ payload, filters: u._f })
                return Promise.resolve({ data: null, error: null }).then(res, rej)
              },
            }
            return u
          },
        }
        return b
      },
    }
  }

  const oauthRow = (overrides = {}) => credentialRow({
    provider: 'microsoft',
    auth_type: 'oauth',
    secret_ciphertext: null,
    oauth_access_token_ciphertext: seal('ACCESS-SPENT'),
    oauth_refresh_token_ciphertext: seal('REFRESH-LIVE'),
    // Already dead: without a renewal this send is refused.
    oauth_expires_at: new Date(Date.now() - 60_000).toISOString(),
    smtp_host: 'smtp.office365.com',
    smtp_port: 587,
    smtp_secure: false,
    ...overrides,
  })

  const tokenEndpoint = (status, body) => vi.fn(async () => ({
    ok: status >= 200 && status < 300, status, json: async () => body,
  }))

  beforeEach(() => { Object.assign(process.env, OAUTH_ENV) })
  afterEach(() => {
    for (const k of Object.keys(OAUTH_ENV)) delete process.env[k]
    vi.unstubAllGlobals()
  })

  // 🔴 THE REGRESSION PIN. Every mailbox in production is a password mailbox.
  it('🔴 A PASSWORD MAILBOX MAKES NO TOKEN REQUEST AND NO WRITE — nothing changed for it', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const t = fakeTransport()
    const db = fakeDbWithWrites(credentialRow())

    const res = await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db, ...t.deps })

    expect(res.ok).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(db.updates).toEqual([])
    // And the credential still reaches nodemailer as a plain LOGIN pair.
    expect(t.made[0].auth).toEqual({ user: 'hello@theirgym.ie', pass: APP_PASSWORD })
    expect(t.made[0].auth.type).toBeUndefined()
  })

  it('renews a spent token and sends with the NEW one', async () => {
    vi.stubGlobal('fetch', tokenEndpoint(200, {
      access_token: 'ACCESS-RENEWED', refresh_token: 'REFRESH-ROTATED', expires_in: 3600,
    }))
    const t = fakeTransport()
    const db = fakeDbWithWrites(oauthRow())

    const res = await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db, ...t.deps })

    expect(res.ok).toBe(true)
    // 🔴 The XOAUTH2 shape, with the renewed token — nodemailer keys off
    // `auth.type` and drops a bare accessToken into a LOGIN attempt.
    expect(t.made[0].auth).toEqual({
      type: 'OAuth2', user: 'hello@theirgym.ie', accessToken: 'ACCESS-RENEWED',
    })
    expect(t.made[0].auth.pass).toBeUndefined()
  })

  it('persists the rotated refresh token, or the NEXT send breaks instead of this one', async () => {
    vi.stubGlobal('fetch', tokenEndpoint(200, {
      access_token: 'ACCESS-RENEWED', refresh_token: 'REFRESH-ROTATED', expires_in: 3600,
    }))
    const t = fakeTransport()
    const db = fakeDbWithWrites(oauthRow())
    await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db, ...t.deps })
    expect(db.updates).toHaveLength(1)
    expect(db.updates[0].payload.oauth_refresh_token_ciphertext).toBeTruthy()
  })

  // The envelope cannot tell these apart — three routes branch on it — but the
  // SENTENCE must, because one asks the operator to act and the other asks
  // them to wait.
  it('a revoked grant refuses the send and says to sign in again', async () => {
    vi.stubGlobal('fetch', tokenEndpoint(400, { error: 'invalid_grant' }))
    const t = fakeTransport()
    const res = await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db: fakeDbWithWrites(oauthRow()), ...t.deps })
    expect(res).toMatchObject({ ok: false, reason: 'not_configured' })
    expect(res.error).toMatch(/sign in again/i)
    expect(t.sent).toHaveLength(0)
  })

  it('an unreachable identity service says the opposite — nothing for them to fix', async () => {
    vi.stubGlobal('fetch', tokenEndpoint(503, {}))
    const t = fakeTransport()
    const res = await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db: fakeDbWithWrites(oauthRow()), ...t.deps })
    expect(res).toMatchObject({ ok: false, reason: 'not_configured' })
    expect(res.error).not.toMatch(/sign in again/i)
    expect(res.error).toMatch(/Nothing is wrong with the connection/i)
    expect(t.sent).toHaveLength(0)
  })

  // 🔴 Dropping either column does not break loudly — it makes every OAuth
  // mailbox stop sending about an hour after it was connected, reporting an
  // expired sign-in that no operator action can clear.
  it('selects `provider` and the refresh token, or renewal is impossible', async () => {
    vi.stubGlobal('fetch', tokenEndpoint(200, { access_token: 'A', expires_in: 3600 }))
    const t = fakeTransport()
    const db = fakeDb({ row: credentialRow() })
    await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db, ...t.deps })
    expect(db.calls.columns).toContain('provider')
    expect(db.calls.columns).toContain('oauth_refresh_token_ciphertext')
  })

  it('never puts a token in the verdict, on any of these paths', async () => {
    for (const doFetch of [
      tokenEndpoint(200, { access_token: 'ACCESS-RENEWED', refresh_token: 'REFRESH-ROTATED', expires_in: 3600 }),
      tokenEndpoint(400, { error: 'invalid_grant', error_description: 'REFRESH-LIVE rejected' }),
      tokenEndpoint(503, { error_description: 'REFRESH-LIVE' }),
    ]) {
      vi.stubGlobal('fetch', doFetch)
      const t = fakeTransport()
      const res = await sendViaSmtp({ mailbox: MAILBOX, ...SEND }, { db: fakeDbWithWrites(oauthRow()), ...t.deps })
      const serialised = JSON.stringify(res)
      expect(serialised).not.toContain('REFRESH-LIVE')
      expect(serialised).not.toContain('REFRESH-ROTATED')
      expect(serialised).not.toContain('the-client-secret')
    }
  })
})
