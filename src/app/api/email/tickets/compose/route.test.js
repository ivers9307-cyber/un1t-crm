// EMAIL-TICKET.5 — starting a conversation.
//
// Three properties carry the most weight:
//   • THE SENDER CAN ONLY USE A MAILBOX THEY CAN SEE. Someone granted studio@
//     sending as accounts@ is not a cosmetic bug — it is billing
//     correspondence going out under an address they have no claim to, and it
//     is a 404 so the id cannot even be probed.
//   • the ticket belongs to the MAILBOX's location, never to anything the
//     caller named.
//   • a failed send leaves NOTHING behind. A ticket in the queue for an email
//     that never went out is the worst lie a support tool can tell.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/postmark', () => ({ sendEmail: vi.fn() }))

import { POST } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { sendEmail } from '@/lib/postmark'
import { _resetInboxSenderCache, TICKET_INTERNAL_STREAM } from '@/lib/email-inbox-send'
import { EMAIL_ATTACHMENT_BUCKET } from '@/lib/email-attachment-quota'
import { outboundDraftPath } from '@/lib/email-outbound-attachments'
import { makeDb, insertsInto, writesTo, seedObject, failWrites } from '../_test-db'
import {
  LOC_A, MB_STUDIO, MB_ACCOUNTS, MB_OTHER_LOCATION,
  COACH, COACH_NO_INBOX, OWNER, MULTI_LOCATION,
  GRANT_STUDIO, GRANT_MULTI_STUDIO, GRANT_MULTI_OTHER_LOCATION, baseState,
} from '../_test-fixtures'

const UNKNOWN_MAILBOX = '99999999-9999-4999-8999-999999999999'

function post(body) {
  return POST(new Request('http://x/api/email/tickets/compose', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

const VALID = {
  mailbox_id: MB_STUDIO.id,
  to: 'lead@example.com',
  subject: 'Following up on your enquiry',
  text: 'Hi — you asked about the 6am class last week. Still interested?',
}

const MEMBER_CONTACT = {
  id: 'contact-7', location_id: LOC_A,
  email: 'Lead@Example.com', created_at: '2026-01-01T00:00:00Z',
}
const OTHER_CONTACT = {
  id: 'contact-8', location_id: LOC_A,
  email: 'someone.else@example.com', created_at: '2026-01-01T00:00:00Z',
}

let db
function setupDb(state) {
  db = makeDb(state)
  createServerClient.mockImplementation(() => db)
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
  _resetInboxSenderCache()
  process.env.POSTMARK_FROM_EMAIL = 'UN1T <hello@un1t.ie>'
  // EMAIL-OUTBOUND-SERVER.1 — the support inbox's OWN Postmark server.
  process.env.POSTMARK_EMAIL_INBOX_SERVER_TOKEN = 'ticketing-server-token'
  getCurrentUser.mockResolvedValue(COACH)
  sendEmail.mockResolvedValue({ messageId: 'pm-compose-1' })
  // The coach holds studio@ and nothing else — the whole point of the fixture.
  setupDb(baseState({ grants: [GRANT_STUDIO], contacts: [] }))
})

afterEach(() => {
  delete process.env.POSTMARK_EMAIL_INBOX_SERVER_TOKEN
})

describe('POST /api/email/tickets/compose — gates', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post(VALID)).status).toBe(401)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  // EMAIL-TICKET-CLEANUP.1 — 404, not the 403 this used to be, and resolved at
  // the MAILBOX'S location rather than the caller's active one. This route
  // never takes a location; it reads one off the mailbox, so the old gate was
  // answering about a studio the mail was not going to. 404 because a 403 would
  // separate \u201Cthat mailbox exists, elsewhere\u201D from \u201Cno such mailbox\u201D and hand back
  // the enumeration the rest of the route is careful not to give.
  it('404s without the email_inbox permission AT THE MAILBOX\u2019S location, sending nothing', async () => {
    getCurrentUser.mockResolvedValue(COACH_NO_INBOX)
    expect((await post(VALID)).status).toBe(404)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('404s — not 403 — on a mailbox the caller cannot see, and sends nothing', async () => {
    const res = await post({ ...VALID, mailbox_id: MB_ACCOUNTS.id })
    expect(res.status).toBe(404)
    expect(sendEmail).not.toHaveBeenCalled()
    expect(insertsInto(db, 'email_tickets')).toHaveLength(0)
  })

  it('404s on a mailbox at a location the caller has no access to', async () => {
    const res = await post({ ...VALID, mailbox_id: MB_OTHER_LOCATION.id })
    expect(res.status).toBe(404)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('404s on a mailbox id that does not exist', async () => {
    expect((await post({ ...VALID, mailbox_id: UNKNOWN_MAILBOX })).status).toBe(404)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('404s on an INACTIVE mailbox the caller is otherwise granted', async () => {
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      mailboxes: [{ ...MB_STUDIO, active: false }, MB_ACCOUNTS],
    }))
    expect((await post(VALID)).status).toBe(404)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('lets an elevated caller send from an account they hold no grant on', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    setupDb(baseState({ grants: [] }))
    const res = await post({ ...VALID, mailbox_id: MB_ACCOUNTS.id })
    expect(res.status).toBe(200)
    expect(sendEmail.mock.calls[0][0].replyTo).toBe(MB_ACCOUNTS.address)
  })
})

describe('POST /api/email/tickets/compose — validation', () => {
  it('400s on a malformed recipient address', async () => {
    for (const to of ['not-an-email', 'nobody@', '@example.com', '']) {
      expect((await post({ ...VALID, to })).status).toBe(400)
    }
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('400s on a malformed mailbox_id', async () => {
    expect((await post({ ...VALID, mailbox_id: 'not-a-uuid' })).status).toBe(400)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('400s on an empty or oversized subject/body', async () => {
    expect((await post({ ...VALID, subject: '   ' })).status).toBe(400)
    expect((await post({ ...VALID, subject: 'x'.repeat(201) })).status).toBe(400)
    expect((await post({ ...VALID, text: '' })).status).toBe(400)
    expect((await post({ ...VALID, text: 'x'.repeat(10001) })).status).toBe(400)
    expect(sendEmail).not.toHaveBeenCalled()
  })
})

describe('POST /api/email/tickets/compose — the send', () => {
  it('sends on the transactional stream, FROM and Reply-To the chosen mailbox', async () => {
    const res = await post(VALID)
    expect(res.status).toBe(200)

    expect(sendEmail).toHaveBeenCalledTimes(1)
    const sent = sendEmail.mock.calls[0][0]
    expect(sent).toMatchObject({
      to: VALID.to,
      subject: VALID.subject,
      textBody: VALID.text,
      // THIS APP'S stream — transactional.
      stream: 'outbound',
      replyTo: MB_STUDIO.address,
    })
    // EMAIL-OUTBOUND-SERVER.1 — the ticketing server's token + the mailbox as
    // the From, both carried on the sender override.
    expect(sent.sender).toEqual({
      serverToken: 'ticketing-server-token',
      fromEmail: MB_STUDIO.address,
      fromName: null,
    })
  })

  it('rides POSTMARK’s email-send stream while staying internally `outbound`', async () => {
    await post(VALID)
    const sent = sendEmail.mock.calls[0][0]
    expect(sent.postmarkStream).toBe('email-send')
    expect(sent.stream).toBe(TICKET_INTERNAL_STREAM)
  })

  it('logs the INTERNAL stream and the real From to email_sends', async () => {
    setupDb(baseState({ grants: [GRANT_STUDIO], contacts: [
      { id: 'contact-9', location_id: LOC_A, email: VALID.to, created_at: '2026-01-01T00:00:00Z' },
    ] }))
    await post(VALID)
    const [send] = insertsInto(db, 'email_sends')
    expect(send.payload.postmark_stream).toBe('outbound')
    expect(send.payload.postmark_stream).not.toBe('email-send')
    expect(send.payload.from_email).toBe(MB_STUDIO.address)
  })

  it('503s without sending — and without filing a ticket — when unconfigured', async () => {
    delete process.env.POSTMARK_EMAIL_INBOX_SERVER_TOKEN
    const res = await post(VALID)

    expect(res.status).toBe(503)
    expect((await res.json()).error).toContain('POSTMARK_EMAIL_INBOX_SERVER_TOKEN')
    expect(sendEmail).not.toHaveBeenCalled()
    expect(insertsInto(db, 'email_tickets')).toHaveLength(0)
    expect(insertsInto(db, 'email_inbox_messages')).toHaveLength(0)
  })

  it('falls back to a domain we own when the mailbox cannot be sent from', async () => {
    const rejection = Object.assign(new Error('no Sender Signature'), { errorCode: 400, httpStatus: 422 })
    sendEmail.mockRejectedValueOnce(rejection).mockResolvedValue({ messageId: 'pm-fallback' })

    const res = await post(VALID)

    expect(res.status).toBe(200)
    expect(sendEmail).toHaveBeenCalledTimes(2)
    expect(sendEmail.mock.calls[1][0].sender.fromEmail).toBe('UN1T <hello@un1t.ie>')
    expect(sendEmail.mock.calls[1][0].replyTo).toBe(MB_STUDIO.address)
    const [msg] = insertsInto(db, 'email_inbox_messages')
    expect(msg.payload.from_email).toBe('UN1T <hello@un1t.ie>')
  })

  it('a failed send leaves NO ticket and NO message behind', async () => {
    sendEmail.mockRejectedValue(new Error('Postmark rejected the recipient'))
    const res = await post(VALID)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ success: false })
    expect(insertsInto(db, 'email_tickets')).toHaveLength(0)
    expect(insertsInto(db, 'email_inbox_messages')).toHaveLength(0)
    expect(insertsInto(db, 'email_sends')).toHaveLength(0)
    expect(db._state.tickets).toHaveLength(2) // the two fixture tickets, untouched
  })
})

describe('POST /api/email/tickets/compose — what it creates', () => {
  it('creates one ticket + one outbound message and returns the ticket id', async () => {
    const res = await post(VALID)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.ticket_id).toBeTruthy()
    expect(body.data.ticket_id).toBe(body.data.ticket.id)

    const tickets = insertsInto(db, 'email_tickets')
    expect(tickets).toHaveLength(1)
    expect(tickets[0].payload).toMatchObject({
      mailbox_id: MB_STUDIO.id,
      requester_email: VALID.to,
      subject: VALID.subject,
      status: 'open',
      last_message_direction: 'outbound',
    })
    expect(tickets[0].payload.last_message_preview).toContain('you asked about the 6am class')

    const messages = insertsInto(db, 'email_inbox_messages')
    expect(messages).toHaveLength(1)
    expect(messages[0].payload).toMatchObject({
      ticket_id: body.data.ticket_id,
      direction: 'outbound',
      to_email: VALID.to,
      text_body: VALID.text,
      postmark_message_id: 'pm-compose-1',
      is_internal_note: false,
      status: 'sent',
    })
  })

  it('takes location_id from the MAILBOX, on the ticket and the message alike', async () => {
    await post(VALID)
    expect(insertsInto(db, 'email_tickets')[0].payload.location_id).toBe(MB_STUDIO.location_id)
    expect(insertsInto(db, 'email_inbox_messages')[0].payload.location_id).toBe(MB_STUDIO.location_id)
  })

  it('records the author (mig 493) so the thread is not anonymous', async () => {
    await post(VALID)
    expect(insertsInto(db, 'email_inbox_messages')[0].payload.author_profile_id).toBe(COACH.id)
  })

  it('stamps first_response_at — this outbound IS the first response', async () => {
    await post(VALID)
    expect(insertsInto(db, 'email_tickets')[0].payload.first_response_at).toBeTruthy()
  })

  it('normalises the recipient address before storing it', async () => {
    await post({ ...VALID, to: '  Lead@Example.COM ' })
    expect(insertsInto(db, 'email_tickets')[0].payload.requester_email).toBe('lead@example.com')
    expect(sendEmail.mock.calls[0][0].to).toBe('lead@example.com')
  })
})

describe('POST /api/email/tickets/compose — contact linkage', () => {
  it('links a contact whose email matches the recipient, case-insensitively', async () => {
    setupDb(baseState({ grants: [GRANT_STUDIO], contacts: [MEMBER_CONTACT] }))
    await post(VALID)
    expect(insertsInto(db, 'email_tickets')[0].payload.contact_id).toBe(MEMBER_CONTACT.id)
    expect(insertsInto(db, 'email_inbox_messages')[0].payload.contact_id).toBe(MEMBER_CONTACT.id)
    // …and the send is logged to the contact's email history.
    expect(insertsInto(db, 'email_sends')[0].payload).toMatchObject({
      contact_id: MEMBER_CONTACT.id, postmark_stream: 'outbound',
    })
  })

  it('leaves contact_id NULL for a recipient nobody matches', async () => {
    setupDb(baseState({ grants: [GRANT_STUDIO], contacts: [OTHER_CONTACT] }))
    await post(VALID)
    expect(insertsInto(db, 'email_tickets')[0].payload.contact_id).toBeNull()
    expect(insertsInto(db, 'email_inbox_messages')[0].payload.contact_id).toBeNull()
    // contact_id is NOT NULL on email_sends — an unlinked recipient must not
    // take the whole send down.
    expect(insertsInto(db, 'email_sends')).toHaveLength(0)
  })

  it('does not let an ILIKE wildcard in the address link the wrong person', async () => {
    // `_` is a legal email character AND a single-character ILIKE wildcard, so
    // the server-side match alone would file this against axb@example.com.
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      contacts: [{ id: 'contact-9', location_id: LOC_A, email: 'axb@example.com', created_at: '2026-01-01T00:00:00Z' }],
    }))
    await post({ ...VALID, to: 'a_b@example.com' })
    expect(insertsInto(db, 'email_tickets')[0].payload.contact_id).toBeNull()
  })

  // ILIKE-WILDCARD.1 — three independent defences now, and they cover
  // different payloads. Unlike the inbound webhook (which parses the sender
  // with the permissive normalizeEmail regex and so DOES see `%@domain`), this
  // route validates `to` with the strict Zod `email` schema, which rejects a
  // `%` local part outright — so the `%` half never reaches the query here.
  // `_` IS a legal email character, passes Zod, and is the case above.
  it('rejects a "%@domain" recipient at validation, before any query', async () => {
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      contacts: [
        { id: 'contact-a', location_id: LOC_A, email: 'alice@example.com', created_at: '2026-01-01T00:00:00Z' },
        { id: 'contact-b', location_id: LOC_A, email: 'bob@example.com', created_at: '2026-02-01T00:00:00Z' },
      ],
    }))
    const res = await post({ ...VALID, to: '%@example.com' })
    expect(res.status).toBe(400)
    expect(insertsInto(db, 'email_tickets')).toHaveLength(0)
    expect(insertsInto(db, 'email_inbox_messages')).toHaveLength(0)
  })

  it('still links an address that genuinely contains an underscore', async () => {
    // The other direction: over-escaping would break a legitimate recipient.
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      contacts: [{ id: 'contact-u', location_id: LOC_A, email: 'a_b@example.com', created_at: '2026-01-01T00:00:00Z' }],
    }))
    await post({ ...VALID, to: 'a_b@example.com' })
    expect(insertsInto(db, 'email_tickets')[0].payload.contact_id).toBe('contact-u')
  })
})

// EMAIL-TICKET.6 — the contact lookup no longer swallows its error.
describe('POST /api/email/tickets/compose — query failures are loud', () => {
  it('500s BEFORE sending when the contact lookup errors', async () => {
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      contacts: [MEMBER_CONTACT],
      errors: { contacts: { code: '42P01', message: 'relation "contacts" does not exist' } },
    }))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await post(VALID)

    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
    // Swallowing this used to file the ticket against NOBODY. Failing before
    // the send means there is no unlinked ticket and no unsent-but-filed state.
    expect(sendEmail).not.toHaveBeenCalled()
    expect(insertsInto(db, 'email_tickets')).toHaveLength(0)
    expect(errors).toHaveBeenCalled()
    errors.mockRestore()
  })
})

// EMAIL-TICKET-CLEANUP.1 — the permission follows the MAILBOX'S location.
//
// This route never takes a location: it reads one off the mailbox, precisely so
// a ticket can only land at the studio that owns the sending address. The old
// hasPermission() gate therefore asked about a studio the mail was NOT going
// to. Composing FROM an address is the strongest thing this surface does — the
// recipient sees that studio's name — so a key held elsewhere must not buy it.
describe('POST /api/email/tickets/compose — the permission follows the MAILBOX’S location', () => {
  beforeEach(() => {
    getCurrentUser.mockResolvedValue(MULTI_LOCATION)
    setupDb(baseState({
      grants: [GRANT_MULTI_STUDIO, GRANT_MULTI_OTHER_LOCATION],
      contacts: [],
    }))
  })

  it('ALLOWS composing from the studio where they hold the key', async () => {
    // The wrongly-DENIED direction: the old gate read an active location this
    // user does not have and refused their own composer outright.
    expect((await post(VALID)).status).toBe(200)
    expect(sendEmail).toHaveBeenCalledTimes(1)
  })

  it('DENIES composing from the studio where they do not, despite a grant there', async () => {
    // The direction that sends mail as a business you hold no key for. 404, not
    // 403 — a 403 would separate "that mailbox exists, elsewhere" from "no such
    // mailbox" and hand back the enumeration this route avoids everywhere else.
    const res = await post({ ...VALID, mailbox_id: MB_OTHER_LOCATION.id })
    expect(res.status).toBe(404)
    expect(sendEmail).not.toHaveBeenCalled()
    expect(writesTo(db)).toEqual([])
  })
})

// EMAIL-TICKET-CLEANUP.2 — a FAILED visibility lookup is not "no mailboxes".
describe('POST /api/email/tickets/compose — a failed mailbox lookup is not an empty one', () => {
  it('500s instead of 404ing, and sends nothing', async () => {
    // As an empty set this 404'd — telling the operator the address they just
    // picked out of the composer's own dropdown does not exist. Nothing has
    // been sent at this point, so refusing costs a retry and nothing else.
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      contacts: [],
      errors: { email_mailbox_access: { code: '42501', message: 'permission denied' } },
    }))
    expect((await post(VALID)).status).toBe(500)
    expect(sendEmail).not.toHaveBeenCalled()
    expect(writesTo(db)).toEqual([])
  })
})

// ── EMAIL-OUTBOUND-ATTACH.1 ─────────────────────────────────────────
// A new email can carry files. Same rules as the reply route, deliberately —
// one composer, one set of limits — so these tests cover the compose-specific
// half: the mailbox (not a ticket) is what the upload was authorised against,
// and the ticket + message + attachment rows all land together.
describe('POST /api/email/tickets/compose — attachments', () => {
  const DRAFT = '22222222-2222-4222-8222-222222222222'
  const draftRef = (index, mime = 'application/pdf', filename = 'terms.pdf') =>
    ({ draft_id: DRAFT, index, filename, mime })

  function seedDraft(index, { mime = 'application/pdf', bytes = 'hello world' } = {}) {
    const path = outboundDraftPath({ profileId: COACH.id, draftId: DRAFT, index, mime })
    seedObject(db, EMAIL_ATTACHMENT_BUCKET, path, bytes)
    return path
  }

  it('sends the file and files it against the new ticket’s first message', async () => {
    seedDraft(0)
    const res = await post({ ...VALID, attachments: [draftRef(0)] })
    expect(res.status).toBe(200)

    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [{
        Name: 'terms.pdf',
        Content: Buffer.from('hello world').toString('base64'),
        ContentType: 'application/pdf',
      }],
    }))

    const messageId = db._state.messages.find(m => m.direction === 'outbound')?.id
    const [att] = insertsInto(db, 'email_ticket_attachments')
    expect(att.payload).toMatchObject({
      message_id: messageId,
      location_id: LOC_A,
      mailbox_id: MB_STUDIO.id,
      attachment_index: 0,
      filename: 'terms.pdf',
      storage_path: `${LOC_A}/${messageId}/0.pdf`,
      skipped_reason: null,
    })
  })

  it('sends NO Attachments key at all when there are none', async () => {
    await post(VALID)
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ attachments: undefined }))
    expect(insertsInto(db, 'email_ticket_attachments')).toEqual([])
  })

  it('REFUSES 400 before the send when a draft cannot be read, writing NOTHING', async () => {
    const res = await post({ ...VALID, attachments: [draftRef(0)] })
    expect(res.status).toBe(400)
    expect(sendEmail).not.toHaveBeenCalled()
    // No ticket in the queue for an email that never went — the property this
    // route's send-first ordering exists to guarantee, now extended to files.
    expect(writesTo(db)).toEqual([])
  })

  it('REFUSES 400 past the size ceiling, naming the limit', async () => {
    seedDraft(0, { bytes: Buffer.alloc(4 * 1024 * 1024, 1) })
    seedDraft(1, { bytes: Buffer.alloc(4 * 1024 * 1024, 1) })
    const res = await post({ ...VALID, attachments: [draftRef(0), draftRef(1)] })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('7.0 MB')
    expect(writesTo(db)).toEqual([])
  })

  it('a mailbox the caller cannot send as is still a 404, files or not', async () => {
    seedDraft(0)
    const res = await post({ ...VALID, mailbox_id: MB_ACCOUNTS.id, attachments: [draftRef(0)] })
    expect(res.status).toBe(404)
    expect(sendEmail).not.toHaveBeenCalled()
    expect(writesTo(db)).toEqual([])
  })
})

// ── EMAIL-CC.1 — several recipients, Cc and Bcc ──────────────────────
//
// Unlike a reply, NOTHING here is derived: every address on a composed email
// is one a person typed, because nobody wrote to us first. That is the one
// place ticket mail can reach an address the member never involved, so the
// bounds under test are the cap, the validation and the attribution.
describe('POST /api/email/tickets/compose — recipients', () => {
  it('still accepts the SCALAR `to` that shipped before EMAIL-CC.1', async () => {
    expect((await post(VALID)).status).toBe(200)
    expect(sendEmail.mock.calls[0][0].to).toBe('lead@example.com')
  })

  it('sends to several To recipients', async () => {
    const res = await post({ ...VALID, to: ['lead@example.com', 'partner@example.com'] })
    expect(res.status).toBe(200)
    expect(sendEmail.mock.calls[0][0].to).toBe('lead@example.com, partner@example.com')
  })

  it('carries Cc and Bcc on the wire, each in its own Postmark field', async () => {
    await post({ ...VALID, cc: ['colleague@example.com'], bcc: ['boss@example.com'] })
    const sent = sendEmail.mock.calls[0][0]
    expect(sent.cc).toBe('colleague@example.com')
    expect(sent.bcc).toBe('boss@example.com')
    expect(sent.to).not.toContain('boss@example.com')
    expect(sent.cc).not.toContain('boss@example.com')
  })

  // ONE ticket has ONE counterpart. to[0] is who requester_email names, who
  // the contact link resolves against, and who a later reply threads from.
  it('files the ticket against the PRIMARY recipient, not a cc’d colleague', async () => {
    setupDb(baseState({ grants: [GRANT_STUDIO], contacts: [MEMBER_CONTACT, OTHER_CONTACT] }))
    await post({ ...VALID, to: ['lead@example.com', 'partner@example.com'], cc: ['someone.else@example.com'] })
    const [ticket] = insertsInto(db, 'email_tickets')
    expect(ticket.payload.requester_email).toBe('lead@example.com')
    expect(ticket.payload.contact_id).toBe(MEMBER_CONTACT.id)
  })

  it('stores all three lists on the message row', async () => {
    await post({
      ...VALID,
      to: ['lead@example.com', 'partner@example.com'],
      cc: ['colleague@example.com'],
      bcc: ['boss@example.com'],
    })
    const [msg] = insertsInto(db, 'email_inbox_messages')
    expect(msg.payload.to_email).toBe('lead@example.com')
    expect(msg.payload.to_emails).toEqual(['lead@example.com', 'partner@example.com'])
    expect(msg.payload.cc_emails).toEqual(['colleague@example.com'])
    expect(msg.payload.bcc_emails).toEqual(['boss@example.com'])
  })

  it('dedupes across To, Cc and Bcc case-insensitively, To winning', async () => {
    await post({
      ...VALID,
      to: ['Lead@Example.com'],
      cc: ['LEAD@example.com', 'colleague@example.com'],
      bcc: ['Colleague@example.com', 'boss@example.com'],
    })
    const sent = sendEmail.mock.calls[0][0]
    expect(sent.to).toBe('lead@example.com')
    expect(sent.cc).toBe('colleague@example.com')
    expect(sent.bcc).toBe('boss@example.com')
  })

  // Cc'ing one of our own mailboxes delivers a copy to our own inbound
  // webhook, which — with no threading header to match — files a brand-new
  // ticket at the same studio. A phantom enquiry, from us, on every send.
  it('strips the studio’s own addresses from every list', async () => {
    await post({ ...VALID, cc: [MB_STUDIO.address], bcc: [MB_ACCOUNTS.address] })
    const sent = sendEmail.mock.calls[0][0]
    expect(sent.cc).toBeUndefined()
    expect(sent.bcc).toBeUndefined()
  })

  it('400s on an invalid address without sending or writing anything', async () => {
    const res = await post({ ...VALID, cc: ['not-an-address'] })
    expect(res.status).toBe(400)
    expect(sendEmail).not.toHaveBeenCalled()
    expect(writesTo(db)).toEqual([])
  })

  it('400s past the recipient cap, server-side', async () => {
    const many = Array.from({ length: 25 }, (_, i) => `c${i}@example.com`)
    const res = await post({ ...VALID, cc: many })
    expect(res.status).toBe(400)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('400s on a Cc with no To — that is not an email anyone can reply to', async () => {
    const res = await post({ ...VALID, to: [], cc: ['colleague@example.com'] })
    expect(res.status).toBe(400)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  // Every address here was typed by a person, so the WHOLE set is logged —
  // this is the deliberate half of the "adding a stranger" answer.
  it('audit-logs the whole recipient set under the sender’s name', async () => {
    await post({ ...VALID, cc: ['colleague@example.com'], bcc: ['boss@example.com'] })
    const [audit] = insertsInto(db, 'audit_events')
    expect(audit.payload).toMatchObject({
      action: 'email_ticket.composed',
      actor_id: COACH.id,
      location_id: LOC_A,
    })
    expect(audit.payload.details.added)
      .toEqual(['lead@example.com', 'colleague@example.com', 'boss@example.com'])
    expect(audit.payload.details.recipient_count).toBe(3)
  })

  // Without the own-address list a cc'd own-address would go out. On THIS
  // route that branch is unreachable in practice — the mailbox the sender
  // picked is read from the same table and refuses first, with the 404 that
  // keeps mailbox ids unprobeable. The property the test pins is the one that
  // matters either way: an email_mailboxes fault never reaches Postmark.
  it('refuses and sends nothing when email_mailboxes is unreadable', async () => {
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      contacts: [],
      errors: { email_mailboxes: { code: '42703', message: 'column does not exist' } },
    }))
    expect((await post(VALID)).status).toBe(404)
    expect(sendEmail).not.toHaveBeenCalled()
    expect(writesTo(db)).toEqual([])
  })
})

// ── EMAIL-COMPOSE-UNFILED.1 — filing fails AFTER the send ────────────
//
// Everything above refuses BEFORE Postmark is called. These pin the other side
// of the send-first ordering: the email is with the recipient and a write then
// failed. The route already answered with "Do not resend" copy; what was
// missing (audit 2026-08-08, residual from EMAIL-REPLY-UNFILED.1) was any
// coverage of either branch, the machine-readable `data.sent` flag the reply
// route now carries, and a durable record of the delivered send — in the
// ticket-insert case NOTHING referenced it anywhere.
//
// `failWrites` (shared harness, ../_test-db.js) fails WRITES only —
// `state.errors` would fail the mailbox read too and the route would 404
// before sending.
describe('POST /api/email/tickets/compose — filing fails AFTER the send (EMAIL-COMPOSE-UNFILED.1)', () => {
  let errors
  beforeEach(() => {
    errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => errors.mockRestore())

  it('TICKET insert fails → says the mail is ALREADY SENT, never the raw DB error', async () => {
    failWrites(db, ['email_tickets'])
    const res = await post(VALID)

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toMatch(/was sent/i)
    expect(body.error).toMatch(/do not resend/i)
    expect(body.error).not.toContain('write exploded')
    expect(body.data).toMatchObject({ sent: true, message_id: 'pm-compose-1' })
    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect(errors).toHaveBeenCalled()
  })

  it('TICKET insert fails → the delivered send is dead-lettered AND logged for the contact', async () => {
    // Without these two rows the send would exist NOWHERE — no ticket, no
    // message, nothing for the delivery webhook to correlate against.
    setupDb(baseState({ grants: [GRANT_STUDIO], contacts: [MEMBER_CONTACT] }))
    failWrites(db, ['email_tickets'])
    await post(VALID)

    const [dead] = insertsInto(db, 'webhook_dead_letter')
    expect(dead.payload).toMatchObject({
      // NOT a REPLAYABLE_PROVIDERS key — a replay of a send that already
      // happened would BE the double-send.
      provider: 'email_ticket_compose',
      event_type: 'sent_not_filed',
      location_id: LOC_A,
    })
    expect(dead.payload.payload).toMatchObject({
      ticket_id: null,
      mailbox_id: MB_STUDIO.id,
      postmark_message_id: 'pm-compose-1',
      subject: VALID.subject,
      text_body: VALID.text,
    })
    expect(dead.payload.payload.recipients.to).toEqual(['lead@example.com'])

    const [sendRow] = insertsInto(db, 'email_sends')
    expect(sendRow.payload).toMatchObject({
      contact_id: MEMBER_CONTACT.id,
      postmark_message_id: 'pm-compose-1',
      source_type: 'inbox_compose',
    })
  })

  it('MESSAGE insert fails → the ticket STAYS, and the flag carries its id', async () => {
    setupDb(baseState({ grants: [GRANT_STUDIO], contacts: [MEMBER_CONTACT] }))
    failWrites(db, ['email_inbox_messages'])
    const res = await post(VALID)

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toMatch(/was sent/i)
    expect(body.error).toMatch(/do not resend/i)
    expect(body.data).toMatchObject({ sent: true, message_id: 'pm-compose-1' })
    // The ticket row survives — the queue still shows what was sent and to
    // whom (the branch's existing behaviour, now pinned)…
    expect(body.data.ticket_id).toBeTruthy()
    expect(db._state.tickets.find(t => t.id === body.data.ticket_id)).toBeTruthy()
    // …and both breadcrumbs name it.
    const [dead] = insertsInto(db, 'webhook_dead_letter')
    expect(dead.payload.provider).toBe('email_ticket_compose')
    expect(dead.payload.payload.ticket_id).toBe(body.data.ticket_id)
    const [sendRow] = insertsInto(db, 'email_sends')
    expect(sendRow.payload.postmark_message_id).toBe('pm-compose-1')
  })

  it('keeps the distinct answer when every breadcrumb ALSO fails', async () => {
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {})
    failWrites(db, ['email_tickets', 'email_inbox_messages', 'email_sends', 'webhook_dead_letter'])
    const res = await post(VALID)

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toMatch(/do not resend/i)
    expect(body.data).toMatchObject({ sent: true })
    warns.mockRestore()
  })
})

// ─────────────────────────────────────────────────────────────────────
// Signature (the EMAIL-TICKET.5 TODO, finally honoured). A composed new
// email is a ticket whose first message is outbound — NOT a second concept —
// so it signs exactly the way a reply does: appendSignature() before the
// text→HTML conversion, the SIGNED body on the wire AND on the row, and the
// queue preview left unsigned. Mirrors the reply route's suite so the two
// paths cannot drift apart silently again.
describe('sender signature', () => {
  const SIGNED = { ...COACH, email_signature: 'Sarah\nUN1T Stillorgan' }

  it('appends the sender’s signature to what leaves', async () => {
    getCurrentUser.mockResolvedValue(SIGNED)
    await post(VALID)

    const sent = sendEmail.mock.calls[0][0]
    expect(sent.textBody).toBe(`${VALID.text}\n\n-- \nSarah\nUN1T Stillorgan`)
    // The HTML body is the SAME string through the route's escaper, so the
    // signature can never take a different (un-escaped) path to the member.
    expect(sent.htmlBody).toContain(`${VALID.text}\n\n-- \nSarah\nUN1T Stillorgan`)
  })

  it('escapes the signature exactly as it escapes the body', async () => {
    getCurrentUser.mockResolvedValue({ ...COACH, email_signature: 'R&D <team@un1t.ie>' })
    await post({ ...VALID, text: 'a > b & c' })

    const sent = sendEmail.mock.calls[0][0]
    expect(sent.htmlBody).toContain('a &gt; b &amp; c')
    expect(sent.htmlBody).toContain('R&amp;D &lt;team@un1t.ie&gt;')
    expect(sent.htmlBody).not.toContain('<team@un1t.ie>')
    expect(sent.textBody).toContain('R&D <team@un1t.ie>')
  })

  it.each([
    ['NULL', null],
    ['unset', undefined],
    ['empty', ''],
    ['whitespace only', '   \n  '],
  ])('a %s signature appends NOTHING — no stray "--"', async (_label, signature) => {
    getCurrentUser.mockResolvedValue({ ...COACH, email_signature: signature })
    await post(VALID)

    const sent = sendEmail.mock.calls[0][0]
    expect(sent.textBody).toBe(VALID.text)
    expect(sent.textBody).not.toContain('--')
    const [msg] = insertsInto(db, 'email_inbox_messages')
    expect(msg.payload.text_body).toBe(VALID.text)
  })

  it('stores the SIGNED body on the message row — the record of what was sent', async () => {
    getCurrentUser.mockResolvedValue(SIGNED)
    await post(VALID)
    const [msg] = insertsInto(db, 'email_inbox_messages')
    expect(msg.payload.text_body).toBe(`${VALID.text}\n\n-- \nSarah\nUN1T Stillorgan`)
  })

  it('keeps the queue preview unsigned', async () => {
    getCurrentUser.mockResolvedValue(SIGNED)
    await post(VALID)
    const [ticket] = insertsInto(db, 'email_tickets')
    expect(ticket.payload.last_message_preview).not.toContain('Sarah')
  })

  it('dead-letters the SIGNED body when the send is unfiled — the re-fileable record', async () => {
    getCurrentUser.mockResolvedValue(SIGNED)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    failWrites(db, ['email_tickets'])
    await post(VALID)

    const [dead] = insertsInto(db, 'webhook_dead_letter')
    expect(dead.payload.payload.text_body).toBe(`${VALID.text}\n\n-- \nSarah\nUN1T Stillorgan`)
    errors.mockRestore()
  })
})

// MAIL-SENT.1 — outbound-born: the ticket starts in Sent, not Inbox.
it('a composed conversation is born has_inbound: false', async () => {
  setupDb(baseState({ grants: [GRANT_STUDIO] }))
  const res = await post(VALID)
  expect(res.status).toBe(200)
  const [insert] = insertsInto(db, 'email_tickets')
  expect(insert.payload.has_inbound).toBe(false)
})

// ── MAIL-SIG.1 — the rich signature rides every send ────────────────────
it('an enabled rich signature lands in BOTH parts — html block appended after conversion, text under the separator', async () => {
  getCurrentUser.mockResolvedValue({
    ...COACH,
    email_signature: 'old plain sig',
    email_signature_rich: {
      enabled: true, name: 'Garrett Ivers', title: 'GM',
      links: [{ label: 'IG', url: 'https://instagram.com/un1t' }],
    },
  })
  setupDb(baseState({ grants: [GRANT_STUDIO] }))
  const res = await post(VALID)
  expect(res.status).toBe(200)
  const sent = sendEmail.mock.calls[0][0]
  expect(sent.textBody).toContain('-- \nGarrett Ivers')
  expect(sent.textBody).not.toContain('old plain sig') // rich outranks plain
  expect(sent.htmlBody).toContain('href="https://instagram.com/un1t"')
  expect(sent.htmlBody).toContain('Garrett Ivers')
})

it('a DISABLED rich signature keeps the plain path byte-for-byte', async () => {
  getCurrentUser.mockResolvedValue({
    ...COACH,
    email_signature: 'Plain sign-off',
    email_signature_rich: { enabled: false, name: 'Nope' },
  })
  setupDb(baseState({ grants: [GRANT_STUDIO] }))
  await post(VALID)
  const sent = sendEmail.mock.calls[0][0]
  expect(sent.textBody).toContain('Plain sign-off')
  expect(sent.htmlBody).not.toContain('Nope')
})

// MAIL-SIG.2 — the SENDING studio's signature parts outrank the personal ones.
it('the sending studio supplies the signature line, phone and links', async () => {
  getCurrentUser.mockResolvedValue({
    ...COACH,
    email_signature_rich: {
      enabled: true, name: 'Richard Ivers', note: 'UN1T Dublin',
      phone: '+353 1 578 9401',
      links: [{ label: 'personal', url: 'https://richardivers.com' }],
    },
  })
  setupDb(baseState({
    grants: [GRANT_STUDIO],
    locations: [{ id: LOC_A, name: 'UN1T Hatch Street' }],
    companySettings: [{
      location_id: LOC_A,
      email_signature: {
        phone: '(01) 574 1871',
        links: [{ label: 'Book a class', url: 'https://un1tdublin.com/welcome/hatch-street#start' }],
      },
    }],
  }))
  await post(VALID)
  const sent = sendEmail.mock.calls[0][0]
  expect(sent.htmlBody).toContain('UN1T Hatch Street')
  expect(sent.htmlBody).toContain('(01) 574 1871')
  expect(sent.htmlBody).toContain('href="https://un1tdublin.com/welcome/hatch-street#start"')
  expect(sent.htmlBody).not.toContain('richardivers.com')
})
