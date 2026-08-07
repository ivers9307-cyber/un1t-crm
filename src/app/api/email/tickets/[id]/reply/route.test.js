// EMAIL-TICKET.4 — the reply path.
//
// Two properties carry the most weight:
//   • an internal note is written to the thread and NOTHING is sent. The
//     member never sees it, so a note that reaches Postmark is a leak, not a
//     cosmetic bug.
//   • a reply rides the TRANSACTIONAL stream with no marketing-consent gate.
//     The member wrote to us first; a suppression flag swallowing the answer
//     to their own question is worse than the consent risk it avoids.
//
// EMAIL-TICKET.5 adds three more (mig 493): the signature is appended to
// replies and NEVER to notes and NEVER when it is empty; author_profile_id is
// written on both kinds of message; and the legacy email_conversations mirror
// can fail without taking the member's answer down with it.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/permissions', async () => {
  const actual = await vi.importActual('@/lib/permissions')
  return { ...actual, hasPermission: vi.fn(() => true) }
})
vi.mock('@/lib/postmark', () => ({ sendEmail: vi.fn() }))

import { POST } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { sendEmail } from '@/lib/postmark'
import { makeDb, insertsInto, updatesTo } from '../../_test-db'
import {
  MB_STUDIO, T_STUDIO, T_ACCOUNTS, COACH, GRANT_STUDIO, baseState,
} from '../../_test-fixtures'

function post(id, body) {
  return POST(
    new Request(`http://x/api/email/tickets/${id}/reply`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  )
}

const LAST_INBOUND = {
  id: 'm-1', ticket_id: T_STUDIO.id, location_id: T_STUDIO.location_id,
  direction: 'inbound', subject: 'Class times', text_body: 'What time is the 6am?',
  rfc_message_id: '<inbound-1@mail.example.com>',
  references_header: '<older@mail.example.com>',
  is_internal_note: false, created_at: '2026-08-06T09:00:00Z',
}

// The same inbound message as the webhook actually writes it: carrying BOTH
// ids for the length of the mig 394 transition. That conversation_id is the
// only thing that makes the legacy mirror reachable from a ticket.
const CONVERSATION_ID = 'ccccccc1-0000-4000-8000-000000000001'
const LAST_INBOUND_DUAL = { ...LAST_INBOUND, conversation_id: CONVERSATION_ID }

const SIGNED_COACH = { ...COACH, email_signature: 'Sarah\nUN1T Stillorgan' }

let db
function setupDb(state) {
  db = makeDb(state)
  createServerClient.mockImplementation(() => db)
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.POSTMARK_FROM_EMAIL = 'UN1T <hello@un1t.ie>'
  hasPermission.mockReturnValue(true)
  getCurrentUser.mockResolvedValue(COACH)
  sendEmail.mockResolvedValue({ messageId: 'pm-out-1' })
  setupDb(baseState({ grants: [GRANT_STUDIO], messages: [LAST_INBOUND] }))
})

describe('POST …/reply — gates', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post(T_STUDIO.id, { text: 'hi' })).status).toBe(401)
  })

  it('403s without the email_inbox permission', async () => {
    hasPermission.mockReturnValue(false)
    expect((await post(T_STUDIO.id, { text: 'hi' })).status).toBe(403)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('404s on a ticket whose mailbox the caller cannot see, and sends nothing', async () => {
    expect((await post(T_ACCOUNTS.id, { text: 'hi' })).status).toBe(404)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('400s on an empty or oversized body', async () => {
    expect((await post(T_STUDIO.id, { text: '' })).status).toBe(400)
    expect((await post(T_STUDIO.id, { text: 'x'.repeat(10001) })).status).toBe(400)
    expect(sendEmail).not.toHaveBeenCalled()
  })
})

describe('POST …/reply — internal note', () => {
  it('writes a note and sends NOTHING', async () => {
    const res = await post(T_STUDIO.id, { text: 'Checked with accounts — waiting on them.', internal: true })
    expect(res.status).toBe(200)
    expect(sendEmail).not.toHaveBeenCalled()

    const [msg] = insertsInto(db, 'email_inbox_messages')
    expect(msg.payload).toMatchObject({
      ticket_id: T_STUDIO.id,
      direction: 'outbound',
      is_internal_note: true,
      text_body: 'Checked with accounts — waiting on them.',
    })
    expect(msg.payload.postmark_message_id).toBeUndefined()
  })

  it('does not stamp first_response_at or advance the ticket', async () => {
    await post(T_STUDIO.id, { text: 'internal', internal: true })
    expect(updatesTo(db, 'email_tickets')).toHaveLength(0)
    expect(db._state.tickets.find(t => t.id === T_STUDIO.id).first_response_at).toBeNull()
    expect(db._state.tickets.find(t => t.id === T_STUDIO.id).status).toBe('open')
  })

  it('never logs a note to email_sends', async () => {
    await post(T_STUDIO.id, { text: 'internal', internal: true })
    expect(insertsInto(db, 'email_sends')).toHaveLength(0)
  })

  it('is NEVER signed, even when the author has a signature', async () => {
    getCurrentUser.mockResolvedValue(SIGNED_COACH)
    await post(T_STUDIO.id, { text: 'Checked with accounts.', internal: true })
    const [msg] = insertsInto(db, 'email_inbox_messages')
    // A note goes to nobody, so a sign-off on it is noise on a staff line.
    expect(msg.payload.text_body).toBe('Checked with accounts.')
    expect(msg.payload.text_body).not.toContain('--')
    expect(msg.payload.text_body).not.toContain('Sarah')
  })

  it('records WHO left it', async () => {
    await post(T_STUDIO.id, { text: 'internal', internal: true })
    const [msg] = insertsInto(db, 'email_inbox_messages')
    expect(msg.payload.author_profile_id).toBe(COACH.id)
  })

  it('never mirrors to email_conversations — nothing was sent', async () => {
    setupDb(baseState({ grants: [GRANT_STUDIO], messages: [LAST_INBOUND_DUAL] }))
    await post(T_STUDIO.id, { text: 'internal', internal: true })
    expect(updatesTo(db, 'email_conversations')).toHaveLength(0)
  })
})

describe('POST …/reply — real reply', () => {
  it('sends on the transactional stream, replying from the ticket’s own mailbox', async () => {
    const res = await post(T_STUDIO.id, { text: 'We open at 6.' })
    expect(res.status).toBe(200)

    expect(sendEmail).toHaveBeenCalledTimes(1)
    const sent = sendEmail.mock.calls[0][0]
    expect(sent).toMatchObject({
      to: T_STUDIO.requester_email,
      stream: 'outbound',
      // Reply-To is the address the member wrote to, so their next reply
      // threads back onto this ticket.
      replyTo: MB_STUDIO.address,
      textBody: 'We open at 6.',
    })
    // From is NOT the mailbox address — that needs per-domain DKIM (later plan).
    expect(sent.from).toBeUndefined()
    // Threading anchors come off the last inbound message.
    expect(JSON.stringify(sent.headers)).toContain(LAST_INBOUND.rfc_message_id)
  })

  it('moves the ticket to pending and refreshes the queue summary', async () => {
    await post(T_STUDIO.id, { text: 'We open at 6.' })
    const [update] = updatesTo(db, 'email_tickets')
    expect(update.payload).toMatchObject({
      status: 'pending',
      last_message_direction: 'outbound',
      last_message_preview: expect.stringContaining('We open at 6.'),
    })
    expect(update.payload.last_message_at).toBeTruthy()
  })

  it('stamps first_response_at once and never again', async () => {
    await post(T_STUDIO.id, { text: 'first' })
    const stamped = updatesTo(db, 'email_tickets')[0].payload.first_response_at
    expect(stamped).toBeTruthy()

    await post(T_STUDIO.id, { text: 'second' })
    expect(updatesTo(db, 'email_tickets')[1].payload.first_response_at).toBeUndefined()
  })

  it('clears solved_at/closed_at when a reply pulls a solved ticket back into play', async () => {
    setupDb(baseState({
      grants: [GRANT_STUDIO], messages: [LAST_INBOUND],
      tickets: [{ ...T_STUDIO, status: 'solved', solved_at: '2026-08-05T00:00:00Z' }],
    }))
    await post(T_STUDIO.id, { text: 'One more thing —' })
    expect(updatesTo(db, 'email_tickets')[0].payload).toMatchObject({
      status: 'pending', solved_at: null, closed_at: null,
    })
  })

  it('writes the outbound message and logs it to email_sends for the contact', async () => {
    await post(T_STUDIO.id, { text: 'We open at 6.' })
    const [msg] = insertsInto(db, 'email_inbox_messages')
    expect(msg.payload).toMatchObject({
      ticket_id: T_STUDIO.id,
      direction: 'outbound',
      is_internal_note: false,
      postmark_message_id: 'pm-out-1',
      in_reply_to: LAST_INBOUND.rfc_message_id,
      status: 'sent',
    })
    const [send] = insertsInto(db, 'email_sends')
    expect(send.payload).toMatchObject({
      contact_id: T_STUDIO.contact_id, postmark_stream: 'outbound', source_type: 'inbox_reply',
    })
  })

  it('skips the email_sends log when no contact is linked', async () => {
    setupDb(baseState({
      grants: [GRANT_STUDIO], messages: [LAST_INBOUND],
      tickets: [{ ...T_STUDIO, contact_id: null }],
    }))
    await post(T_STUDIO.id, { text: 'hi' })
    // contact_id is NOT NULL on email_sends — an unlinked requester must not
    // take the whole reply down.
    expect(insertsInto(db, 'email_sends')).toHaveLength(0)
    expect(insertsInto(db, 'email_inbox_messages')).toHaveLength(1)
  })

  it('a failed send leaves the ticket untouched — never a false "pending"', async () => {
    sendEmail.mockRejectedValue(new Error('Postmark rejected the recipient'))
    const res = await post(T_STUDIO.id, { text: 'We open at 6.' })
    expect(res.status).toBe(400)
    expect(updatesTo(db, 'email_tickets')).toHaveLength(0)
    expect(insertsInto(db, 'email_inbox_messages')).toHaveLength(0)
    expect(db._state.tickets.find(t => t.id === T_STUDIO.id).status).toBe('open')
  })

  it('records WHO sent it', async () => {
    await post(T_STUDIO.id, { text: 'We open at 6.' })
    const [msg] = insertsInto(db, 'email_inbox_messages')
    // from_email stays the Postmark From — that is what went on the wire, not
    // an author field.
    expect(msg.payload.author_profile_id).toBe(COACH.id)
    expect(msg.payload.from_email).toBe('UN1T <hello@un1t.ie>')
  })
})

describe('POST …/reply — signature (EMAIL-TICKET.5)', () => {
  it('appends it after a blank line and the "-- " separator, on BOTH bodies', async () => {
    getCurrentUser.mockResolvedValue(SIGNED_COACH)
    await post(T_STUDIO.id, { text: 'We open at 6.' })

    const sent = sendEmail.mock.calls[0][0]
    expect(sent.textBody).toBe('We open at 6.\n\n-- \nSarah\nUN1T Stillorgan')
    // The HTML body is the SAME string through the route's escaper, so the
    // signature can never take a different (un-escaped) path to the member.
    expect(sent.htmlBody).toContain('We open at 6.\n\n-- \nSarah\nUN1T Stillorgan')
  })

  it('escapes the signature exactly as it escapes the body', async () => {
    // The column is plain text precisely so this can never be an HTML hole.
    getCurrentUser.mockResolvedValue({ ...COACH, email_signature: 'R&D <team@un1t.ie>' })
    await post(T_STUDIO.id, { text: 'a > b & c' })

    const sent = sendEmail.mock.calls[0][0]
    expect(sent.htmlBody).toContain('a &gt; b &amp; c')
    expect(sent.htmlBody).toContain('R&amp;D &lt;team@un1t.ie&gt;')
    expect(sent.htmlBody).not.toContain('<team@un1t.ie>')
    // …and the text body keeps the literal characters.
    expect(sent.textBody).toContain('R&D <team@un1t.ie>')
  })

  it.each([
    ['NULL', null],
    ['unset', undefined],
    ['empty', ''],
    ['whitespace only', '   \n  '],
  ])('a %s signature appends NOTHING — no stray "--"', async (_label, signature) => {
    getCurrentUser.mockResolvedValue({ ...COACH, email_signature: signature })
    await post(T_STUDIO.id, { text: 'We open at 6.' })

    const sent = sendEmail.mock.calls[0][0]
    expect(sent.textBody).toBe('We open at 6.')
    expect(sent.textBody).not.toContain('--')
    const [msg] = insertsInto(db, 'email_inbox_messages')
    expect(msg.payload.text_body).toBe('We open at 6.')
  })

  it('stores the SIGNED body on the message row — the record of what was sent', async () => {
    getCurrentUser.mockResolvedValue(SIGNED_COACH)
    await post(T_STUDIO.id, { text: 'We open at 6.' })
    const [msg] = insertsInto(db, 'email_inbox_messages')
    expect(msg.payload.text_body).toBe('We open at 6.\n\n-- \nSarah\nUN1T Stillorgan')
  })

  it('keeps the queue preview unsigned', async () => {
    getCurrentUser.mockResolvedValue(SIGNED_COACH)
    await post(T_STUDIO.id, { text: 'We open at 6.' })
    // Otherwise every short reply looks identical in the ticket list.
    const [update] = updatesTo(db, 'email_tickets')
    expect(update.payload.last_message_preview).toBe('We open at 6.')
  })
})

describe('POST …/reply — legacy email_conversations mirror (EMAIL-TICKET.5)', () => {
  it('stamps the conversation onto the message and refreshes its summary', async () => {
    setupDb(baseState({ grants: [GRANT_STUDIO], messages: [LAST_INBOUND_DUAL] }))
    const res = await post(T_STUDIO.id, { text: 'We open at 6.' })
    expect(res.status).toBe(200)
    expect((await res.json()).data.conversation_id).toBe(CONVERSATION_ID)

    // One row carrying BOTH ids — same shape the inbound webhook writes.
    // A second message row would double the reply in the ticket thread.
    expect(insertsInto(db, 'email_inbox_messages')).toHaveLength(1)
    const [stamp] = updatesTo(db, 'email_inbox_messages')
    expect(stamp.payload).toEqual({ conversation_id: CONVERSATION_ID })

    const [conv] = updatesTo(db, 'email_conversations')
    expect(conv.payload).toMatchObject({
      last_message_direction: 'outbound',
      last_message_preview: 'We open at 6.',
    })
    expect(conv.payload.last_message_at).toBeTruthy()
  })

  it('does nothing when the ticket has no legacy conversation', async () => {
    // Tickets minted after email_conversations is retired are the normal case,
    // not an error.
    setupDb(baseState({ grants: [GRANT_STUDIO], messages: [LAST_INBOUND] }))
    const res = await post(T_STUDIO.id, { text: 'We open at 6.' })
    expect(res.status).toBe(200)
    expect((await res.json()).data.conversation_id).toBeNull()
    expect(updatesTo(db, 'email_conversations')).toHaveLength(0)
    expect(updatesTo(db, 'email_inbox_messages')).toHaveLength(0)
  })

  it('a mirror that BLOWS UP still returns success — the member was answered', async () => {
    setupDb(baseState({ grants: [GRANT_STUDIO], messages: [LAST_INBOUND_DUAL] }))
    const realFrom = db.from
    db.from = (table) => {
      if (table === 'email_conversations') throw new Error('legacy table is gone')
      return realFrom(table)
    }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await post(T_STUDIO.id, { text: 'We open at 6.' })

    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
    // The things that actually matter all happened.
    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect(insertsInto(db, 'email_inbox_messages')).toHaveLength(1)
    expect(updatesTo(db, 'email_tickets')).toHaveLength(1)
    expect(errors).toHaveBeenCalled()
    errors.mockRestore()
  })
})
