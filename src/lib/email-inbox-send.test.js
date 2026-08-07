// EMAIL-OUTBOUND-SERVER.1 — ticket mail leaves on the SUPPORT INBOX'S OWN
// Postmark server.
//
// Asserted AT THE WIRE (spying on fetch, real sendEmail) rather than against a
// mocked sendEmail, because every property that matters here is a property of
// the HTTP request: which server token authenticates it, which MessageStream it
// names, which From it carries. A mock would let all three be wrong together.
//
// THE ONE THAT MATTERS MOST is the pair pinned in "the two streams never
// touch": ONE ticket reply is internally 'outbound' (transactional consent,
// no tracking) AND rides Postmark's 'email-send'. Two values, two jobs. If a
// future edit collapses them, nothing else in the suite would notice — the
// send would still work and the consent family would still *happen* to come
// out right, for the wrong reason.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./tenant-email', () => ({ resolveEmailSender: vi.fn() }))
vi.mock('./supabase', () => ({ createServerClient: vi.fn(() => ({ __service: true })) }))

import {
  sendTicketEmail,
  resolveInboxServerToken,
  inboxMessageStream,
  fallbackFromAddress,
  isSenderSignatureError,
  plannedFroms,
  _resetInboxSenderCache,
  TICKET_INTERNAL_STREAM,
  DEFAULT_INBOX_MESSAGE_STREAM,
  SENDER_SIGNATURE_ERROR_CODES,
} from './email-inbox-send.js'
import { consentFieldForStream } from './postmark.js'
import { resolveEmailSender } from './tenant-email.js'

const INBOX_TOKEN = 'ticketing-server-token'
const MARKETING_TOKEN = 'marketing-server-token'
const GLOBAL_FROM = 'UN1T <hello@un1t.ie>'
const HATCH = 'accounts@hatchstreetfitness.com'
// A domain the business does not control — it can never be DKIM-verified, so
// Postmark refuses it at submit time. Named after the real case.
const STILLORGAN = 'stillorgan@un1t.com'

const bodyOf = (call) => JSON.parse(call[1].body)
const tokenOf = (call) => call[1].headers['X-Postmark-Server-Token']

function okResponse(messageId = 'pm-1') {
  return {
    ok: true,
    status: 200,
    json: async () => ({ MessageID: messageId, To: 'member@example.com', SubmittedAt: '2026-08-07T10:00:00Z' }),
  }
}

/** Postmark's real refusal for an unverified From: HTTP 422 + ErrorCode 400. */
function signatureRejection() {
  return {
    ok: false,
    status: 422,
    json: async () => ({
      ErrorCode: 400,
      Message: "You are trying to send email from 'stillorgan@un1t.com' which does not have a corresponding Sender Signature.",
    }),
  }
}

const SEND = Object.freeze({
  to: 'member@example.com',
  subject: 'Re: Class times',
  htmlBody: '<div>We open at 6.</div>',
  textBody: 'We open at 6.',
  tag: 'ticket-reply',
  metadata: { ticket_id: 't-1', contact_id: 'c-1' },
})

let fetchSpy

beforeEach(() => {
  vi.clearAllMocks()
  _resetInboxSenderCache()
  process.env.POSTMARK_EMAIL_INBOX_SERVER_TOKEN = INBOX_TOKEN
  process.env.POSTMARK_API_KEY = MARKETING_TOKEN
  process.env.POSTMARK_FROM_EMAIL = GLOBAL_FROM
  delete process.env.POSTMARK_EMAIL_INBOX_STREAM
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.POSTMARK_EMAIL_INBOX_SERVER_TOKEN
  delete process.env.POSTMARK_EMAIL_INBOX_STREAM
})

// ─────────────────────────────────────────────────────────────────────
describe('the two streams never touch', () => {
  it('ONE reply is internally `outbound` AND on Postmark stream `email-send`', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse())
    await sendTicketEmail({ ...SEND, mailboxAddress: HATCH })

    const body = bodyOf(fetchSpy.mock.calls[0])
    // Postmark's vocabulary, on the wire.
    expect(body.MessageStream).toBe('email-send')
    // Ours, unchanged — and it is a DIFFERENT string.
    expect(TICKET_INTERNAL_STREAM).toBe('outbound')
    expect(body.MessageStream).not.toBe(TICKET_INTERNAL_STREAM)
  })

  it('the internal stream still resolves to the ADMINISTRATIVE consent family', () => {
    // The whole point of keeping them apart. A Postmark stream id here would
    // fall through consentFieldForStream's else-branch to email_marketing and
    // gate a support reply on marketing consent.
    expect(consentFieldForStream(TICKET_INTERNAL_STREAM)).toBe('email_administrative')
    expect(consentFieldForStream(inboxMessageStream())).toBe('email_marketing')
  })

  it('the Postmark stream id is not one of our internal values', () => {
    expect(['broadcast', 'outbound']).not.toContain(inboxMessageStream())
  })

  it('never attaches List-Unsubscribe headers — ticket mail is transactional', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse())
    await sendTicketEmail({ ...SEND, mailboxAddress: HATCH })
    expect(bodyOf(fetchSpy.mock.calls[0]).Headers).toBeUndefined()
  })

  it('never tracks opens or clicks (EMAIL-NOTRACK.1, via the internal stream)', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse())
    await sendTicketEmail({ ...SEND, mailboxAddress: HATCH })
    const body = bodyOf(fetchSpy.mock.calls[0])
    expect(body.TrackOpens).toBe(false)
    expect(body.TrackLinks).toBe('None')
  })
})

// ─────────────────────────────────────────────────────────────────────
describe('the server token', () => {
  it('sends on the TICKETING server, never the marketing one', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse())
    await sendTicketEmail({ ...SEND, mailboxAddress: HATCH })
    expect(tokenOf(fetchSpy.mock.calls[0])).toBe(INBOX_TOKEN)
    expect(tokenOf(fetchSpy.mock.calls[0])).not.toBe(MARKETING_TOKEN)
  })

  it('REFUSES rather than falling back to the marketing server when unset', async () => {
    delete process.env.POSTMARK_EMAIL_INBOX_SERVER_TOKEN
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse())

    const res = await sendTicketEmail({ ...SEND, mailboxAddress: HATCH })

    expect(res.ok).toBe(false)
    expect(res.reason).toBe('not_configured')
    // NOTHING went out. A fallback here would restore the exact defect this
    // module removes, invisibly.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('names the env var in the refusal, and says loudly why', async () => {
    delete process.env.POSTMARK_EMAIL_INBOX_SERVER_TOKEN
    const res = await sendTicketEmail({ ...SEND, mailboxAddress: HATCH })
    expect(res.error).toContain('POSTMARK_EMAIL_INBOX_SERVER_TOKEN')
    expect(console.error).toHaveBeenCalled()
  })

  it('does not read the global token helper at all', () => {
    delete process.env.POSTMARK_EMAIL_INBOX_SERVER_TOKEN
    process.env.POSTMARK_SERVER_TOKEN = 'legacy-marketing-token'
    expect(resolveInboxServerToken()).toBeNull()
    delete process.env.POSTMARK_SERVER_TOKEN
  })

  it('never consults the per-tenant sending domain resolver', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse())
    await sendTicketEmail({ ...SEND, mailboxAddress: HATCH })
    expect(resolveEmailSender).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────
describe('the message stream id', () => {
  it('defaults to email-send', () => {
    expect(inboxMessageStream()).toBe(DEFAULT_INBOX_MESSAGE_STREAM)
    expect(DEFAULT_INBOX_MESSAGE_STREAM).toBe('email-send')
  })

  it('is overridable without a deploy', async () => {
    process.env.POSTMARK_EMAIL_INBOX_STREAM = 'support-outbound'
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse())
    await sendTicketEmail({ ...SEND, mailboxAddress: HATCH })
    expect(bodyOf(fetchSpy.mock.calls[0]).MessageStream).toBe('support-outbound')
  })

  it('ignores a blank override rather than sending an empty stream', () => {
    process.env.POSTMARK_EMAIL_INBOX_STREAM = '   '
    expect(inboxMessageStream()).toBe(DEFAULT_INBOX_MESSAGE_STREAM)
  })
})

// ─────────────────────────────────────────────────────────────────────
describe('From — the mailbox address', () => {
  it('sends FROM the ticket’s own mailbox when it is sendable', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse())
    const res = await sendTicketEmail({ ...SEND, mailboxAddress: HATCH })

    expect(bodyOf(fetchSpy.mock.calls[0]).From).toBe(HATCH)
    // The caller logs what actually went out, not a guess.
    expect(res.fromEmail).toBe(HATCH)
    expect(res.degraded).toBeNull()
  })

  it('keeps Reply-To on the mailbox so the answer threads back', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse())
    await sendTicketEmail({ ...SEND, mailboxAddress: HATCH })
    expect(bodyOf(fetchSpy.mock.calls[0]).ReplyTo).toBe(HATCH)
  })

  it('falls back to a domain we own when the ticket has no mailbox', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse())
    const res = await sendTicketEmail({ ...SEND, mailboxAddress: null })

    const body = bodyOf(fetchSpy.mock.calls[0])
    expect(body.From).toBe(GLOBAL_FROM)
    expect(body.ReplyTo).toBeUndefined()
    expect(res.degraded).toBe('no_mailbox')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

// ─────────────────────────────────────────────────────────────────────
describe('From — an unverifiable domain degrades, it does not break', () => {
  it('retries from a domain we own, Reply-To the real mailbox', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(signatureRejection())
      .mockResolvedValueOnce(okResponse('pm-fallback'))

    const res = await sendTicketEmail({ ...SEND, mailboxAddress: STILLORGAN })

    expect(res.ok).toBe(true)
    expect(res.degraded).toBe('unverified_sender')
    expect(res.result.messageId).toBe('pm-fallback')
    expect(fetchSpy).toHaveBeenCalledTimes(2)

    expect(bodyOf(fetchSpy.mock.calls[0]).From).toBe(STILLORGAN)
    const second = bodyOf(fetchSpy.mock.calls[1])
    expect(second.From).toBe(GLOBAL_FROM)
    // The member can still reply to the address they know.
    expect(second.ReplyTo).toBe(STILLORGAN)
    // Still the ticketing server, still the ticketing stream.
    expect(tokenOf(fetchSpy.mock.calls[1])).toBe(INBOX_TOKEN)
    expect(second.MessageStream).toBe('email-send')
    expect(res.fromEmail).toBe(GLOBAL_FROM)
  })

  it('remembers the refusal, so the next send skips the doomed attempt', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(signatureRejection())
      .mockResolvedValue(okResponse())

    await sendTicketEmail({ ...SEND, mailboxAddress: STILLORGAN })
    fetchSpy.mockClear()

    const res = await sendTicketEmail({ ...SEND, mailboxAddress: STILLORGAN })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(bodyOf(fetchSpy.mock.calls[0]).From).toBe(GLOBAL_FROM)
    expect(res.degraded).toBe('unverified_sender')
  })

  it('the memory is per-address — a verified mailbox is unaffected', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(signatureRejection())
      .mockResolvedValue(okResponse())

    await sendTicketEmail({ ...SEND, mailboxAddress: STILLORGAN })
    fetchSpy.mockClear()

    await sendTicketEmail({ ...SEND, mailboxAddress: HATCH })
    expect(bodyOf(fetchSpy.mock.calls[0]).From).toBe(HATCH)
  })

  it('does NOT retry a rejection that is not about the sender signature', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 422,
      // 406 = inactive recipient. Retrying from another From would send to an
      // address Postmark has already suppressed.
      json: async () => ({ ErrorCode: 406, Message: 'You tried to send to a recipient that has been marked as inactive.' }),
    })

    const res = await sendTicketEmail({ ...SEND, mailboxAddress: STILLORGAN })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('send_failed')
    expect(res.error).toContain('inactive')
  })

  it('does NOT retry an unknown message stream — that is a config error to surface', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ ErrorCode: 1235, Message: "The 'MessageStream' provided does not exist on this server." }),
    })

    const res = await sendTicketEmail({ ...SEND, mailboxAddress: HATCH })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('MessageStream')
  })

  it('does NOT retry a network failure — the send may have been accepted', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('socket hang up'))
    const res = await sendTicketEmail({ ...SEND, mailboxAddress: STILLORGAN })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(res.ok).toBe(false)
  })

  it('never throws, whatever Postmark does', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'))
    await expect(sendTicketEmail({ ...SEND, mailboxAddress: HATCH })).resolves.toMatchObject({ ok: false })
  })
})

// ─────────────────────────────────────────────────────────────────────
describe('isSenderSignatureError', () => {
  it('is true for Postmark’s two sender-signature codes', () => {
    for (const errorCode of SENDER_SIGNATURE_ERROR_CODES) {
      expect(isSenderSignatureError({ errorCode, httpStatus: 422 })).toBe(true)
    }
    expect(SENDER_SIGNATURE_ERROR_CODES).toEqual([400, 401])
  })

  it('is false for every other rejection', () => {
    for (const errorCode of [300, 406, 429, 1235, 0, null, undefined]) {
      expect(isSenderSignatureError({ errorCode, httpStatus: 422, message: 'nope' })).toBe(false)
    }
  })

  it('catches a 422 that names a sender signature under an unlisted code', () => {
    // Second net: getting the code set slightly wrong should degrade to "send
    // from a domain we own", not to "support replies stop".
    expect(isSenderSignatureError({ errorCode: 999, httpStatus: 422, message: 'Sender Signature not found' })).toBe(true)
  })

  it('is bounded by the 422 — a 500 naming a signature is not retried', () => {
    expect(isSenderSignatureError({ errorCode: 999, httpStatus: 500, message: 'sender signature service down' })).toBe(false)
  })

  it('is false for a bare transport error and for nothing at all', () => {
    expect(isSenderSignatureError(new Error('socket hang up'))).toBe(false)
    expect(isSenderSignatureError(null)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────
describe('plannedFroms (pure)', () => {
  it('mailbox first, then the fallback', () => {
    expect(plannedFroms({ mailboxAddress: HATCH, fallback: GLOBAL_FROM })).toEqual([
      { from: HATCH, degraded: null },
      { from: GLOBAL_FROM, degraded: 'unverified_sender' },
    ])
  })

  it('fallback only when there is no mailbox', () => {
    expect(plannedFroms({ mailboxAddress: null, fallback: GLOBAL_FROM })).toEqual([
      { from: GLOBAL_FROM, degraded: 'no_mailbox' },
    ])
  })

  it('skips a mailbox already known to be unsendable', () => {
    expect(plannedFroms({ mailboxAddress: STILLORGAN, fallback: GLOBAL_FROM, skipMailbox: true })).toEqual([
      { from: GLOBAL_FROM, degraded: 'unverified_sender' },
    ])
  })

  it('never plans the same address twice', () => {
    expect(plannedFroms({ mailboxAddress: GLOBAL_FROM, fallback: GLOBAL_FROM })).toEqual([
      { from: GLOBAL_FROM, degraded: null },
    ])
  })

  it('treats a blank mailbox address as absent', () => {
    expect(plannedFroms({ mailboxAddress: '   ', fallback: GLOBAL_FROM })).toEqual([
      { from: GLOBAL_FROM, degraded: 'no_mailbox' },
    ])
  })

  it('there is no domain allowlist anywhere in the rule', () => {
    // Any address is attempted; Postmark is the authority on which can send.
    const [first] = plannedFroms({ mailboxAddress: 'x@some-domain-nobody-listed.example', fallback: GLOBAL_FROM })
    expect(first.from).toBe('x@some-domain-nobody-listed.example')
  })
})

describe('fallbackFromAddress', () => {
  it('is POSTMARK_FROM_EMAIL', () => {
    expect(fallbackFromAddress()).toBe(GLOBAL_FROM)
  })

  it('mirrors sendEmail’s own last-resort default when that is unset', () => {
    delete process.env.POSTMARK_FROM_EMAIL
    expect(fallbackFromAddress()).toBe('UN1T <hello@un1t.ie>')
    process.env.POSTMARK_FROM_EMAIL = GLOBAL_FROM
  })
})
