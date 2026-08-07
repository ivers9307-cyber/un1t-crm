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

import { describe, it, expect, vi, beforeEach } from 'vitest'

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
import { makeDb, insertsInto, writesTo } from '../_test-db'
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
  process.env.POSTMARK_FROM_EMAIL = 'UN1T <hello@un1t.ie>'
  getCurrentUser.mockResolvedValue(COACH)
  sendEmail.mockResolvedValue({ messageId: 'pm-compose-1' })
  // The coach holds studio@ and nothing else — the whole point of the fixture.
  setupDb(baseState({ grants: [GRANT_STUDIO], contacts: [] }))
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
  it('sends on the transactional stream, Reply-To the chosen mailbox', async () => {
    const res = await post(VALID)
    expect(res.status).toBe(200)

    expect(sendEmail).toHaveBeenCalledTimes(1)
    const sent = sendEmail.mock.calls[0][0]
    expect(sent).toMatchObject({
      to: VALID.to,
      subject: VALID.subject,
      textBody: VALID.text,
      stream: 'outbound',
      replyTo: MB_STUDIO.address,
    })
    // From is NOT the mailbox address — that needs per-domain DKIM (later plan).
    expect(sent.from).toBeUndefined()
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
