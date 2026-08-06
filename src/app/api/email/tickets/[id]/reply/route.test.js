// EMAIL-TICKET.4 — the reply path.
//
// Two properties carry the most weight:
//   • an internal note is written to the thread and NOTHING is sent. The
//     member never sees it, so a note that reaches Postmark is a leak, not a
//     cosmetic bug.
//   • a reply rides the TRANSACTIONAL stream with no marketing-consent gate.
//     The member wrote to us first; a suppression flag swallowing the answer
//     to their own question is worse than the consent risk it avoids.

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
})
