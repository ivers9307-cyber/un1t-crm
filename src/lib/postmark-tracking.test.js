// EMAIL-NOTRACK.1 — open/click tracking is a MARKETING-only instrument.
//
// Richard's call (2026-08-07): delivery status yes; open and click tracking
// no on one-to-one mail. Before this, sendEmail/sendBatch set
// `TrackOpens: true` + `TrackLinks: 'HtmlOnly'` unconditionally, so a ticket
// reply, a contract, a password reset and a receipt shipped the same tracking
// pixel and the same link rewriting as a marketing blast.
//
// What this file locks:
//   1. MARKETING IS BYTE-IDENTICAL. The broadcast payload must serialise with
//      the same keys, in the same order, with the same values as before —
//      campaign open/click rates cannot move.
//   2. Transactional mail sets NEITHER field (explicit false/'None', never an
//      omitted key that could inherit a Postmark dashboard default).
//   3. OMISSION IS SAFE. A call site that says nothing gets no tracking —
//      this is the regression that matters, because `stream` has always
//      defaulted to 'broadcast' on the wire and the obvious implementation
//      (key on the resolved stream) makes tracking the silent default again.
//   4. The explicit per-call override works in both directions.
//   5. Unsubscribe compliance is untouched — an omitted stream still rides
//      the broadcast stream and still gets the RFC 8058 one-click headers.
//
// Mutation-checked: see the MUTATION notes on the individual tests.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./supabase', () => ({ createServerClient: vi.fn(() => ({ __service: true })) }))
vi.mock('./tenant-email', () => ({ resolveEmailSender: vi.fn(async () => null) }))

import {
  resolveTracking,
  MARKETING_STREAM,
  sendEmail,
  sendBatch,
  sendTransactionalEmail,
} from './postmark.js'

const okSingle = () => vi.spyOn(globalThis, 'fetch').mockResolvedValue({
  ok: true,
  status: 200,
  json: async () => ({ MessageID: 'pm-1', To: 'a@x.ie', SubmittedAt: '2026-08-07T10:00:00Z' }),
})
const okBatch = (n = 1) => vi.spyOn(globalThis, 'fetch').mockResolvedValue({
  ok: true,
  status: 200,
  json: async () => Array.from({ length: n }, (_, i) => ({ ErrorCode: 0, MessageID: `pm-${i}` })),
})
const bodyOf = (spy, i = 0) => JSON.parse(spy.mock.calls[i][1].body)

beforeEach(() => {
  vi.clearAllMocks()
  process.env.POSTMARK_API_KEY = 'test-token'
  process.env.POSTMARK_FROM_EMAIL = 'UN1T <hello@un1t.ie>'
})
afterEach(() => { vi.restoreAllMocks() })

// ── the pure split ───────────────────────────────────────────────
describe('resolveTracking — the marketing/transactional split', () => {
  it('MARKETING (broadcast) tracks opens and rewrites links', () => {
    expect(resolveTracking({ stream: 'broadcast' }))
      .toEqual({ TrackOpens: true, TrackLinks: 'HtmlOnly' })
  })

  // MUTATION: delete the `stream === MARKETING_STREAM` condition and always
  // return TRACKING_ON → this test goes red.
  it('TRANSACTIONAL (outbound) tracks neither', () => {
    expect(resolveTracking({ stream: 'outbound' }))
      .toEqual({ TrackOpens: false, TrackLinks: 'None' })
  })

  // MUTATION: restore `stream = 'broadcast'` as a destructuring default in
  // sendEmail, or key resolveTracking on the RESOLVED stream → red.
  // This is the whole point: the safe outcome is the one you get by omission.
  it('an UNSTATED stream is not a marketing declaration — no tracking', () => {
    expect(resolveTracking({}))
      .toEqual({ TrackOpens: false, TrackLinks: 'None' })
    expect(resolveTracking())
      .toEqual({ TrackOpens: false, TrackLinks: 'None' })
  })

  it('an unrecognised stream gets no tracking (fails closed)', () => {
    expect(resolveTracking({ stream: 'some-new-stream' }))
      .toEqual({ TrackOpens: false, TrackLinks: 'None' })
  })

  it('explicit opt-IN wins over a transactional stream', () => {
    expect(resolveTracking({ stream: 'outbound', trackEngagement: true }))
      .toEqual({ TrackOpens: true, TrackLinks: 'HtmlOnly' })
  })

  it('explicit opt-OUT wins over the marketing stream', () => {
    expect(resolveTracking({ stream: 'broadcast', trackEngagement: false }))
      .toEqual({ TrackOpens: false, TrackLinks: 'None' })
  })

  it('only a real boolean overrides — a truthy/nullish value defers to the stream', () => {
    // Guards against `trackEngagement: undefined` (an unset prop passed
    // through a spread) accidentally reading as an opt-out, and against a
    // stray truthy string forcing a pixel onto transactional mail.
    expect(resolveTracking({ stream: 'broadcast', trackEngagement: undefined }))
      .toEqual({ TrackOpens: true, TrackLinks: 'HtmlOnly' })
    expect(resolveTracking({ stream: 'outbound', trackEngagement: 'yes' }))
      .toEqual({ TrackOpens: false, TrackLinks: 'None' })
  })

  it('returns a fresh object each call (no shared mutable constant)', () => {
    const a = resolveTracking({ stream: 'broadcast' })
    a.TrackOpens = false
    expect(resolveTracking({ stream: 'broadcast' }).TrackOpens).toBe(true)
  })

  it('MARKETING_STREAM is the broadcast stream', () => {
    expect(MARKETING_STREAM).toBe('broadcast')
  })
})

// ── sendEmail ────────────────────────────────────────────────────
describe('sendEmail — tracking follows the stream', () => {
  it('MARKETING send still sets BOTH fields, unchanged', async () => {
    const spy = okSingle()
    await sendEmail({ to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>', stream: 'broadcast' })
    const body = bodyOf(spy)
    expect(body.TrackOpens).toBe(true)
    expect(body.TrackLinks).toBe('HtmlOnly')
    expect(body.MessageStream).toBe('broadcast')
  })

  // MUTATION: always return TRACKING_ON → red.
  it('TRANSACTIONAL send sets NEITHER — no pixel, no link rewriting', async () => {
    const spy = okSingle()
    await sendEmail({ to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>', stream: 'outbound' })
    const body = bodyOf(spy)
    expect(body.TrackOpens).toBe(false)
    expect(body.TrackLinks).toBe('None')
  })

  it('sends the off-values EXPLICITLY rather than omitting the keys', async () => {
    // An omitted key lets the Postmark server/stream setting decide, which is
    // exactly the silent default this change exists to remove.
    const spy = okSingle()
    await sendEmail({ to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>', stream: 'outbound' })
    const body = bodyOf(spy)
    expect(Object.hasOwn(body, 'TrackOpens')).toBe(true)
    expect(Object.hasOwn(body, 'TrackLinks')).toBe(true)
  })

  // MUTATION: re-add `stream = 'broadcast'` to the destructuring → red.
  it('a call site that specifies NOTHING gets no tracking', async () => {
    const spy = okSingle()
    await sendEmail({ to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>' })
    const body = bodyOf(spy)
    expect(body.TrackOpens).toBe(false)
    expect(body.TrackLinks).toBe('None')
  })

  it('explicit opt-in re-enables tracking on a transactional send', async () => {
    const spy = okSingle()
    await sendEmail({
      to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>',
      stream: 'outbound', trackEngagement: true,
    })
    const body = bodyOf(spy)
    expect(body.TrackOpens).toBe(true)
    expect(body.TrackLinks).toBe('HtmlOnly')
  })

  it('explicit opt-out disables tracking on a marketing send', async () => {
    const spy = okSingle()
    await sendEmail({
      to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>',
      stream: 'broadcast', trackEngagement: false,
    })
    const body = bodyOf(spy)
    expect(body.TrackOpens).toBe(false)
    expect(body.TrackLinks).toBe('None')
  })
})

// ── the payload must not otherwise move ──────────────────────────
describe('sendEmail — marketing payload is byte-identical', () => {
  it('serialises the same keys in the same order as before the split', async () => {
    // The two literals were spread back in at their original position, so a
    // marketing payload's JSON is byte-for-byte what it was. Key ORDER is
    // asserted because JSON.stringify preserves insertion order — this is
    // the actual byte-identity check, not just a value check.
    const spy = okSingle()
    await sendEmail({
      to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>',
      replyTo: 'r@x.ie', stream: 'broadcast', tag: 'campaign-1',
      metadata: { campaign_id: '1' },
    })
    expect(Object.keys(bodyOf(spy))).toEqual([
      'From', 'To', 'Subject', 'HtmlBody', 'TextBody', 'ReplyTo',
      'MessageStream', 'Tag', 'Metadata', 'TrackOpens', 'TrackLinks',
    ])
  })

  it('leaves the one-click unsubscribe headers exactly as they were', async () => {
    const spy = okSingle()
    await sendEmail({
      to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>',
      stream: 'broadcast', unsubscribeUrl: 'https://crm.test/unsubscribe/tok',
    })
    expect(bodyOf(spy).Headers).toEqual([
      { Name: 'List-Unsubscribe', Value: '<https://crm.test/api/unsubscribe/tok>' },
      { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
    ])
  })

  it('an OMITTED stream still rides broadcast and still gets the unsubscribe headers', async () => {
    // Unsubscribe compliance is out of scope: only tracking reads the raw
    // stream. This test is the guard against "fixing" the default stream too.
    const spy = okSingle()
    await sendEmail({
      to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>',
      unsubscribeUrl: 'https://crm.test/unsubscribe/tok',
    })
    const body = bodyOf(spy)
    expect(body.MessageStream).toBe('broadcast')
    expect(body.Headers).toHaveLength(2)
    expect(body.TrackOpens).toBe(false)
  })
})

// ── sendBatch ────────────────────────────────────────────────────
describe('sendBatch — tracking is decided PER EMAIL', () => {
  it('a marketing email in the batch still sets both fields', async () => {
    const spy = okBatch(1)
    await sendBatch([{ to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>', stream: 'broadcast' }])
    expect(bodyOf(spy)[0].TrackOpens).toBe(true)
    expect(bodyOf(spy)[0].TrackLinks).toBe('HtmlOnly')
  })

  // MUTATION: always return TRACKING_ON → red.
  it('a transactional email in the batch sets neither', async () => {
    const spy = okBatch(1)
    await sendBatch([{ to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>', stream: 'outbound' }])
    expect(bodyOf(spy)[0].TrackOpens).toBe(false)
    expect(bodyOf(spy)[0].TrackLinks).toBe('None')
  })

  it('a batch email that specifies NOTHING gets no tracking', async () => {
    const spy = okBatch(1)
    await sendBatch([{ to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>' }])
    expect(bodyOf(spy)[0].TrackOpens).toBe(false)
    expect(bodyOf(spy)[0].TrackLinks).toBe('None')
  })

  it('mixed streams in ONE batch resolve independently', async () => {
    const spy = okBatch(2)
    await sendBatch([
      { to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>', stream: 'broadcast' },
      { to: 'b@x.ie', subject: 'S', htmlBody: '<p>x</p>', stream: 'outbound' },
    ])
    const sent = bodyOf(spy)
    expect(sent[0].TrackOpens).toBe(true)
    expect(sent[1].TrackOpens).toBe(false)
  })

  it('honours a per-email explicit opt-in', async () => {
    const spy = okBatch(1)
    await sendBatch([{
      to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>',
      stream: 'outbound', trackEngagement: true,
    }])
    expect(bodyOf(spy)[0].TrackOpens).toBe(true)
    expect(bodyOf(spy)[0].TrackLinks).toBe('HtmlOnly')
  })

  it('does not leak trackEngagement into the Postmark payload', async () => {
    // It is OUR option, not a Postmark field — Postmark rejects unknown keys.
    const spy = okBatch(1)
    await sendBatch([{
      to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>',
      stream: 'outbound', trackEngagement: true,
    }])
    expect(Object.hasOwn(bodyOf(spy)[0], 'trackEngagement')).toBe(false)
  })
})

// ── the real one-to-one helper ───────────────────────────────────
describe('sendTransactionalEmail — the support/contract/receipt path', () => {
  it('ships no pixel and no rewritten links', async () => {
    // This is the helper behind booking confirmations, receipts and the
    // contract mails. A rewritten link in a contract-signing or
    // password-reset email is a real failure mode, not a privacy nicety.
    const spy = okSingle()
    await sendTransactionalEmail({ to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>' })
    const body = bodyOf(spy)
    expect(body.MessageStream).toBe('outbound')
    expect(body.TrackOpens).toBe(false)
    expect(body.TrackLinks).toBe('None')
  })
})

// ── EMAIL-OUTBOUND-SERVER.1: the wire stream vs OUR stream ───────
//
// `postmarkStream` was added so ticket mail can ride the ticketing server's
// own Postmark stream while staying internally transactional. Everything the
// app decides — tracking, the RFC 8058 unsubscribe gate — must keep reading
// OUR value, and every pre-existing caller (who passes no postmarkStream)
// must serialise exactly as before.
describe('sendEmail — a Postmark stream id never becomes our stream', () => {
  it('puts the provider slug on the wire and leaves tracking on OUR stream', async () => {
    const spy = okSingle()
    await sendEmail({
      to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>',
      stream: 'outbound', postmarkStream: 'email-send',
    })
    const body = bodyOf(spy)
    expect(body.MessageStream).toBe('email-send')
    // Transactional, so still no pixel and no link rewriting.
    expect(body.TrackOpens).toBe(false)
    expect(body.TrackLinks).toBe('None')
  })

  it('does not smuggle the parameter into the payload', async () => {
    const spy = okSingle()
    await sendEmail({
      to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>',
      stream: 'outbound', postmarkStream: 'email-send',
    })
    expect(Object.hasOwn(bodyOf(spy), 'postmarkStream')).toBe(false)
  })

  // MUTATION: gate the unsubscribe headers on `messageStream` (the wire value)
  // instead of the internal one → red. "Is this marketing?" is a question
  // about our own vocabulary; a provider slug cannot answer it.
  it('the unsubscribe gate reads OUR stream, not the wire one', async () => {
    const spy = okSingle()
    await sendEmail({
      to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>',
      stream: 'broadcast', postmarkStream: 'some-other-server-stream',
      unsubscribeUrl: 'https://crm.test/unsubscribe/tok',
    })
    const body = bodyOf(spy)
    expect(body.MessageStream).toBe('some-other-server-stream')
    // Still marketing to us: headers attached, tracking on.
    expect(body.Headers).toHaveLength(2)
    expect(body.TrackOpens).toBe(true)
  })

  it('omitting it is byte-identical — the internal stream goes on the wire', async () => {
    const spy = okSingle()
    await sendEmail({ to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>', stream: 'outbound' })
    expect(bodyOf(spy).MessageStream).toBe('outbound')
  })
})

// ── EMAIL-OUTBOUND-SERVER.1: rejections are machine-readable ─────
describe('sendEmail — a rejection carries Postmark’s classification', () => {
  it('attaches ErrorCode + HttpStatus without changing the message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ ErrorCode: 400, Message: 'No Sender Signature.' }),
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      sendEmail({ to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>' })
    ).rejects.toMatchObject({
      message: 'No Sender Signature.',
      errorCode: 400,
      httpStatus: 422,
    })
  })

  it('leaves errorCode null when Postmark sends no code', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false, status: 500, json: async () => ({}),
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      sendEmail({ to: 'a@x.ie', subject: 'S', htmlBody: '<p>x</p>' })
    ).rejects.toMatchObject({ message: 'Failed to send email', errorCode: null, httpStatus: 500 })
  })
})
