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
// MAILBOX-CONNECT.7 — the SMTP transport is MOCKED here, and only here.
// sendTicketEmail calls sendViaSmtp with production arguments and no test seam
// (deliberately: the seam belongs to the module that owns the socket, not to
// the branch that chooses it), so a mock is the only way to ask the questions
// this file is for — WHICH transport ran, with WHAT, and whether the other one
// was touched. What sendViaSmtp then does with a socket is pinned against a
// fake transporter in src/lib/mail/smtp-send.test.js, including the two rules
// that matter most: the From never falls back, and the password never reaches
// a returned error.
vi.mock('./mail/smtp-send', () => ({ sendViaSmtp: vi.fn() }))

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
import { sendViaSmtp } from './mail/smtp-send.js'

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
// EMAIL-CC.1 × EMAIL-OUTBOUND-SERVER.1 — the two seams meet here.
//
// Recipient POLICY lives in email-recipients.js (validation, dedupe, our own
// addresses, the cap) and TRANSPORT lives here. This block pins the join: all
// three lists arrive already resolved as wire strings and go out untouched.
// Asserted on the real HTTP body for the same reason as everything else in
// this file — "bcc reaches Postmark's Bcc field and NOWHERE else" is a claim
// about the request, and a mocked sendEmail could not falsify it.
describe('recipients pass straight through', () => {
  it('carries Cc and Bcc in their own Postmark fields', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse())
    await sendTicketEmail({
      ...SEND,
      mailboxAddress: HATCH,
      to: 'member@example.com, colleague@example.com',
      cc: 'manager@example.com',
      bcc: 'boss@example.com',
    })

    const body = bodyOf(fetchSpy.mock.calls[0])
    expect(body.To).toBe('member@example.com, colleague@example.com')
    expect(body.Cc).toBe('manager@example.com')
    expect(body.Bcc).toBe('boss@example.com')
  })

  // THE CONFIDENTIALITY GUARANTEE, at the wire. A bcc address that appeared in
  // To, in Cc or in Headers would be visible to every other recipient.
  it('puts a bcc address in `Bcc` and NOWHERE else in the request', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse())
    await sendTicketEmail({
      ...SEND,
      mailboxAddress: HATCH,
      to: 'member@example.com',
      bcc: 'boss@example.com',
      headers: [{ Name: 'In-Reply-To', Value: '<inbound-1@mail.example.com>' }],
    })

    const body = bodyOf(fetchSpy.mock.calls[0])
    const { Bcc, ...everythingElse } = body
    expect(Bcc).toBe('boss@example.com')
    expect(JSON.stringify(everythingElse)).not.toContain('boss@example.com')
  })

  it('omitting them leaves the body exactly as it was before EMAIL-CC.1', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse())
    await sendTicketEmail({ ...SEND, mailboxAddress: HATCH })

    const body = bodyOf(fetchSpy.mock.calls[0])
    expect(body.Cc).toBeUndefined()
    expect(body.Bcc).toBeUndefined()
  })

  // The From degrades; the audience must not. A retry that quietly dropped the
  // Cc would reach fewer people than the first attempt did — and nothing in
  // the response says so.
  it('the sender-signature retry carries the SAME recipients', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(signatureRejection())
      .mockResolvedValueOnce(okResponse('pm-fallback'))

    const res = await sendTicketEmail({
      ...SEND,
      mailboxAddress: STILLORGAN,
      to: 'member@example.com, colleague@example.com',
      cc: 'manager@example.com',
      bcc: 'boss@example.com',
    })

    expect(res.ok).toBe(true)
    const retry = bodyOf(fetchSpy.mock.calls[1])
    expect(retry.From).toBe(GLOBAL_FROM)
    expect(retry.To).toBe('member@example.com, colleague@example.com')
    expect(retry.Cc).toBe('manager@example.com')
    expect(retry.Bcc).toBe('boss@example.com')
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

// ─────────────────────────────────────────────────────────────────────
// EMAIL-OUTBOUND-ATTACH.1 — attachments flow THROUGH this seam, not around it.
// Asserted at the wire for the same reason as everything else here: an
// attachment path that reached Postmark by calling sendEmail() directly would
// send support mail on the MARKETING server, which is the bug this module
// exists to have fixed, and a mocked sendEmail could never show it.
describe('attachments ride the ticketing server, not the marketing one', () => {
  const FILE = { Name: 'invoice.pdf', Content: 'aGVsbG8=', ContentType: 'application/pdf' }

  it('adds NO Attachments key when the caller passes none', async () => {
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(okResponse())
    await sendTicketEmail({ ...SEND, mailboxAddress: HATCH })
    expect(bodyOf(fetchSpy.mock.calls[0])).not.toHaveProperty('Attachments')
  })

  it('puts them on the wire, on the ticketing server and its own stream', async () => {
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(okResponse())
    const res = await sendTicketEmail({ ...SEND, mailboxAddress: HATCH, attachments: [FILE] })
    expect(res.ok).toBe(true)

    const call = fetchSpy.mock.calls[0]
    expect(bodyOf(call).Attachments).toEqual([FILE])
    // The three things this module decides are unchanged by carrying a file.
    expect(tokenOf(call)).toBe(INBOX_TOKEN)
    expect(tokenOf(call)).not.toBe(MARKETING_TOKEN)
    expect(bodyOf(call).MessageStream).toBe(DEFAULT_INBOX_MESSAGE_STREAM)
    expect(bodyOf(call).From).toBe(HATCH)
  })

  it('re-sends the SAME files on the sender-signature fallback attempt', async () => {
    // A 422 is a refusal at SUBMIT time — nothing was transmitted — so the
    // second attempt cannot duplicate the attachment any more than it can
    // duplicate the message.
    fetchSpy = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(signatureRejection())
      .mockResolvedValueOnce(okResponse())

    const res = await sendTicketEmail({ ...SEND, mailboxAddress: STILLORGAN, attachments: [FILE] })
    expect(res.ok).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(bodyOf(fetchSpy.mock.calls[0]).Attachments).toEqual([FILE])
    expect(bodyOf(fetchSpy.mock.calls[1]).Attachments).toEqual([FILE])
    expect(bodyOf(fetchSpy.mock.calls[1]).From).toBe(GLOBAL_FROM)
  })

  it('an unconfigured ticketing server refuses the send, files and all', async () => {
    delete process.env.POSTMARK_EMAIL_INBOX_SERVER_TOKEN
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(okResponse())
    const res = await sendTicketEmail({ ...SEND, mailboxAddress: HATCH, attachments: [FILE] })
    expect(res).toMatchObject({ ok: false, reason: 'not_configured' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────
// MAILBOX-CONNECT.7 — TWO TRANSPORTS, AND THE OLD ONE IS UNTOUCHED.
//
// A mailbox connected over IMAP/SMTP sends its replies through its own
// provider rather than through Postmark, because Postmark cannot DKIM-sign a
// domain the business does not control. `email_mailboxes.egress` (mig 572) is
// the switch and sendTicketEmail branches on it in its first statement.
//
// THE FIRST GROUP IS THE LOAD-BEARING ONE. Three routes call this function
// with no `mailbox` at all, and none of them knows a second transport exists.
// "Nothing changed" is not something to take on trust from a diff — a branch
// added above resolveInboxServerToken() is one typo away from swallowing every
// support reply in the estate, and it would swallow them silently.
describe('transport selection', () => {
  const SMTP_MAILBOX = { id: 'mb-1', address: 'hello@theirgym.ie', egress: 'smtp' }
  const POSTMARK_MAILBOX = { id: 'mb-2', address: HATCH, egress: 'postmark' }

  const SMTP_OK = Object.freeze({
    ok: true,
    result: { messageId: null, rfcMessageId: '<x@theirgym.ie>', accepted: ['member@example.com'] },
    fromEmail: 'hello@theirgym.ie',
    degraded: null,
    deliveryTracked: false,
  })

  describe('no `mailbox` — byte-identical to before this task', () => {
    it('sends through Postmark and never touches the SMTP path', async () => {
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse())
      const res = await sendTicketEmail({ ...SEND, mailboxAddress: HATCH })

      expect(res.ok).toBe(true)
      expect(sendViaSmtp).not.toHaveBeenCalled()
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(tokenOf(fetchSpy.mock.calls[0])).toBe(INBOX_TOKEN)
      expect(bodyOf(fetchSpy.mock.calls[0]).From).toBe(HATCH)
      expect(bodyOf(fetchSpy.mock.calls[0]).MessageStream).toBe(DEFAULT_INBOX_MESSAGE_STREAM)
    })

    it('returns EXACTLY the four keys the routes already destructure', async () => {
      // Not toMatchObject: an extra key is precisely the kind of change that
      // looks harmless and then diverges what three routes write to the
      // database. The SMTP branch's `deliveryTracked` must stay on its own
      // branch.
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse())
      const res = await sendTicketEmail({ ...SEND, mailboxAddress: HATCH })
      expect(Object.keys(res).sort()).toEqual(['degraded', 'fromEmail', 'ok', 'result'])
      expect(res).not.toHaveProperty('deliveryTracked')
    })

    it('still refuses when the ticketing server token is unset', async () => {
      delete process.env.POSTMARK_EMAIL_INBOX_SERVER_TOKEN
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse())
      const res = await sendTicketEmail({ ...SEND, mailboxAddress: HATCH })
      expect(res).toMatchObject({ ok: false, reason: 'not_configured' })
      expect(sendViaSmtp).not.toHaveBeenCalled()
    })

    it('still degrades the From on a sender-signature rejection', async () => {
      // The Postmark path's two-attempt plan is untouched — it is correct
      // THERE, and it is the thing the SMTP path must never inherit.
      fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(signatureRejection())
        .mockResolvedValueOnce(okResponse())
      const res = await sendTicketEmail({ ...SEND, mailboxAddress: STILLORGAN })
      expect(res).toMatchObject({ ok: true, fromEmail: GLOBAL_FROM, degraded: 'unverified_sender' })
      expect(sendViaSmtp).not.toHaveBeenCalled()
    })
  })

  describe('`egress: postmark` — the default column value, same path again', () => {
    it('takes the Postmark path exactly as a missing mailbox does', async () => {
      // mig 572 adds the column NOT NULL DEFAULT 'postmark', so every mailbox
      // in the estate arrives here carrying this value the moment the settings
      // helper starts selecting it. It must be a no-op.
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse())
      const res = await sendTicketEmail({ ...SEND, mailboxAddress: HATCH, mailbox: POSTMARK_MAILBOX })

      expect(res.ok).toBe(true)
      expect(sendViaSmtp).not.toHaveBeenCalled()
      expect(bodyOf(fetchSpy.mock.calls[0]).From).toBe(HATCH)
    })

    it('an unrecognised egress value is treated as Postmark, not as a refusal', async () => {
      // Fail SAFE, not closed: a row written by a newer deploy must not stop a
      // support reply going out. The CHECK constraint is the place that
      // refuses a bad value, at write time, where an operator can see it.
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse())
      const res = await sendTicketEmail({
        ...SEND, mailboxAddress: HATCH, mailbox: { ...POSTMARK_MAILBOX, egress: 'carrier-pigeon' },
      })
      expect(res.ok).toBe(true)
      expect(sendViaSmtp).not.toHaveBeenCalled()
    })
  })

  describe('`egress: smtp` — the connected mailbox sends as itself', () => {
    it('routes to SMTP and never calls Postmark', async () => {
      sendViaSmtp.mockResolvedValue(SMTP_OK)
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse())

      const res = await sendTicketEmail({ ...SEND, mailboxAddress: SMTP_MAILBOX.address, mailbox: SMTP_MAILBOX })

      expect(res).toEqual(SMTP_OK)
      expect(sendViaSmtp).toHaveBeenCalledTimes(1)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('branches AHEAD of the Postmark server token, so an unconfigured one is irrelevant', async () => {
      // The whole point of putting the branch first. An SMTP send has nothing
      // to do with our Postmark account, and refusing it because OUR ticketing
      // server is unconfigured would block a tenant on a fact about us.
      delete process.env.POSTMARK_EMAIL_INBOX_SERVER_TOKEN
      sendViaSmtp.mockResolvedValue(SMTP_OK)
      const res = await sendTicketEmail({ ...SEND, mailbox: SMTP_MAILBOX })
      expect(res.ok).toBe(true)
    })

    it('carries the message, the mailbox, the recipients and the attachments', async () => {
      sendViaSmtp.mockResolvedValue(SMTP_OK)
      const FILE = { Name: 'invoice.pdf', Content: 'aGVsbG8=', ContentType: 'application/pdf' }
      await sendTicketEmail({
        ...SEND,
        mailbox: SMTP_MAILBOX,
        cc: 'colleague@example.com',
        bcc: 'archive@example.com',
        headers: [{ Name: 'In-Reply-To', Value: '<inbound-1@mail.example.com>' }],
        attachments: [FILE],
      })

      expect(sendViaSmtp).toHaveBeenCalledWith(expect.objectContaining({
        mailbox: SMTP_MAILBOX,
        to: SEND.to,
        cc: 'colleague@example.com',
        bcc: 'archive@example.com',
        subject: SEND.subject,
        htmlBody: SEND.htmlBody,
        textBody: SEND.textBody,
        headers: [{ Name: 'In-Reply-To', Value: '<inbound-1@mail.example.com>' }],
        attachments: [FILE],
      }))
    })

    it('does NOT forward `tag` or `metadata` — both are Postmark-only', async () => {
      // `metadata` carries POSTMARK-RACE.1's send marker, which exists so a
      // Delivery webhook can be matched to a row that did not exist yet. There
      // are no webhooks on this path, so forwarding it would be bookkeeping
      // for events that never happen.
      sendViaSmtp.mockResolvedValue(SMTP_OK)
      await sendTicketEmail({ ...SEND, mailbox: SMTP_MAILBOX })

      const args = sendViaSmtp.mock.calls[0][0]
      expect(args).not.toHaveProperty('tag')
      expect(args).not.toHaveProperty('metadata')
    })

    it('🔴 the From never falls back — plannedFroms is not consulted at all', async () => {
      // On SMTP there is no "unverified sender" refusal to catch: the provider
      // sends as the authenticated account, so a fallback would change the
      // address the customer sees rather than rescuing a refused send. The
      // observable form of "plannedFroms did not run" is that nothing about
      // the fallback address reaches the SMTP call and no Postmark attempt is
      // made — even for the address Postmark is known to refuse.
      process.env.POSTMARK_FROM_EMAIL = GLOBAL_FROM
      sendViaSmtp.mockResolvedValue(SMTP_OK)
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(signatureRejection())

      const res = await sendTicketEmail({
        ...SEND, mailboxAddress: STILLORGAN, mailbox: { ...SMTP_MAILBOX, address: STILLORGAN },
      })

      expect(res.ok).toBe(true)
      expect(fetchSpy).not.toHaveBeenCalled()
      const args = sendViaSmtp.mock.calls[0][0]
      expect(JSON.stringify(args)).not.toContain('un1t.ie')
      expect(args).not.toHaveProperty('mailboxAddress')
      expect(args).not.toHaveProperty('from')
    })

    it('an SMTP failure is returned as `send_failed`, not thrown and not retried on Postmark', async () => {
      sendViaSmtp.mockResolvedValue({
        ok: false, reason: 'send_failed', error: 'Invalid login: 535-5.7.8 [redacted]',
      })
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse())

      const res = await sendTicketEmail({ ...SEND, mailbox: SMTP_MAILBOX })

      expect(res).toEqual({
        ok: false, reason: 'send_failed', error: 'Invalid login: 535-5.7.8 [redacted]',
      })
      // Falling back to Postmark on an SMTP failure would send the reply from
      // the wrong domain, unsigned — the exact outcome the connector removes.
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('an unconfigured mailbox is `not_configured`, so the route still answers 503', async () => {
      sendViaSmtp.mockResolvedValue({
        ok: false, reason: 'not_configured', error: 'no mail account is connected to it',
      })
      const res = await sendTicketEmail({ ...SEND, mailbox: SMTP_MAILBOX })
      expect(res.reason).toBe('not_configured')
    })

    it('carries the credential-free error through verbatim', async () => {
      // The redaction itself is smtp-send.js's guarantee and is tested there.
      // What is pinned HERE is that this branch does not decorate, re-wrap or
      // re-log the string on its way out — a second copy of an error is a
      // second place for a credential to end up.
      const error = 'Invalid login: 535-5.7.8 Username and Password not accepted'
      sendViaSmtp.mockResolvedValue({ ok: false, reason: 'send_failed', error })
      const res = await sendTicketEmail({ ...SEND, mailbox: SMTP_MAILBOX })
      expect(res.error).toBe(error)
      expect(Object.keys(res).sort()).toEqual(['error', 'ok', 'reason'])
    })

    it('marks the send as delivery-untracked, which the Postmark path never is', async () => {
      // mig 498's NULL delivery_status means "sent, we have heard nothing".
      // Here it is permanent — no Postmark event can ever arrive — and the
      // thread has to be able to say "not tracked" instead of rendering an
      // event still in flight.
      sendViaSmtp.mockResolvedValue(SMTP_OK)
      const res = await sendTicketEmail({ ...SEND, mailbox: SMTP_MAILBOX })
      expect(res.deliveryTracked).toBe(false)
      expect(res.result.messageId).toBeNull()
    })
  })
})
