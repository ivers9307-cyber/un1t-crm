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
// EMAIL-TICKET.5 adds two more (mig 493): the signature is appended to replies
// and NEVER to notes and NEVER when it is empty; and author_profile_id is
// written on both kinds of message.
//
// EMAIL-CONV-STOP.1 (2026-08-07) removed its third: a non-fatal mirror that
// stamped conversation_id onto the outbound row and refreshed the mig 394
// email_conversations summary. The final describe block below inverts those
// tests — the route must leave that table alone even when a ticket's earlier
// messages still carry a conversation_id, which every row the webhook wrote
// before today does. That is the case that would otherwise keep the write
// alive, so it is the one the fixture uses.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/postmark', () => ({ sendEmail: vi.fn() }))
// MAILFIX-GUARDRAILS.1 — logError is a CALL-THROUGH spy: the real line still
// reaches console.error (the existing `errors` spies stay honest) and the new
// tests can assert the structural call itself rather than a prose substring.
vi.mock('@/lib/log', async () => {
  const actual = await vi.importActual('@/lib/log')
  return { ...actual, logError: vi.fn((...args) => actual.logError(...args)) }
})

import { POST } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { sendEmail } from '@/lib/postmark'
import { logError } from '@/lib/log'
import { _resetInboxSenderCache, TICKET_INTERNAL_STREAM } from '@/lib/email-inbox-send'
import { EMAIL_ATTACHMENT_BUCKET } from '@/lib/email-attachment-quota'
import { outboundDraftPath } from '@/lib/email-outbound-attachments'
import {
  makeDb, insertsInto, updatesTo, writesTo, selectsFrom, seedObject, objectKeys, failWrites,
} from '../../_test-db'
import {
  MB_STUDIO, MB_OTHER_LOCATION, T_STUDIO, T_ACCOUNTS, T_OTHER_LOCATION,
  COACH, COACH_NO_INBOX, MULTI_LOCATION,
  GRANT_STUDIO, GRANT_MULTI_STUDIO, GRANT_MULTI_OTHER_LOCATION, baseState,
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

// An inbound message as the webhook USED to write it: carrying both ids. Every
// row written before EMAIL-CONV-STOP.1 looks like this, and that
// conversation_id was the only thing that made the legacy mirror reachable from
// a ticket — so it is the fixture that would expose a surviving mirror.
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
  _resetInboxSenderCache()
  process.env.POSTMARK_FROM_EMAIL = 'UN1T <hello@un1t.ie>'
  // EMAIL-OUTBOUND-SERVER.1 — the support inbox's OWN Postmark server. Without
  // it the route refuses to send at all, which is the point (see the
  // "unconfigured" test below).
  process.env.POSTMARK_EMAIL_INBOX_SERVER_TOKEN = 'ticketing-server-token'
  getCurrentUser.mockResolvedValue(COACH)
  sendEmail.mockResolvedValue({ messageId: 'pm-out-1' })
  setupDb(baseState({ grants: [GRANT_STUDIO], messages: [LAST_INBOUND] }))
})

afterEach(() => {
  delete process.env.POSTMARK_EMAIL_INBOX_SERVER_TOKEN
})

describe('POST …/reply — gates', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post(T_STUDIO.id, { text: 'hi' })).status).toBe(401)
  })

  // EMAIL-TICKET-CLEANUP.1 — 404, not the 403 this used to be. The gate moved
  // into loadTicketForUser so it can resolve at the TICKET'S location, which
  // means it now runs AFTER the row is read — and a 403 there would say "this
  // id exists, at a studio where you lack the key" while a bad id says 404.
  // Every other way to be refused on this surface is already indistinguishable;
  // a fourth reason has to be too.
  // The caller holds the studio@ GRANT and is assigned to the location. Only
  // the surface key is missing, so this is the one test that isolates it.
  it('404s without the email_inbox permission AT THE TICKET\u2019S location, sending nothing', async () => {
    getCurrentUser.mockResolvedValue(COACH_NO_INBOX)
    expect((await post(T_STUDIO.id, { text: 'hi' })).status).toBe(404)
    expect(sendEmail).not.toHaveBeenCalled()
    expect(writesTo(db)).toEqual([])
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
      // THIS APP'S stream — transactional, gated on email_administrative.
      stream: 'outbound',
      // Reply-To is the address the member wrote to, so their next reply
      // threads back onto this ticket.
      replyTo: MB_STUDIO.address,
      textBody: 'We open at 6.',
    })
    // EMAIL-OUTBOUND-SERVER.1 — From IS the mailbox address now, carried on the
    // sender override alongside the ticketing server's own token.
    expect(sent.sender).toEqual({
      serverToken: 'ticketing-server-token',
      fromEmail: MB_STUDIO.address,
      fromName: null,
    })
    // Threading anchors come off the last inbound message.
    expect(JSON.stringify(sent.headers)).toContain(LAST_INBOUND.rfc_message_id)
  })

  // EMAIL-OUTBOUND-SERVER.1 — the trap this feature has to keep clear of.
  it('rides POSTMARK’s email-send stream while staying internally `outbound`', async () => {
    await post(T_STUDIO.id, { text: 'We open at 6.' })
    const sent = sendEmail.mock.calls[0][0]
    // Two values, two jobs: the provider slug is wire-only, ours decides
    // consent + tracking + what gets logged.
    expect(sent.postmarkStream).toBe('email-send')
    expect(sent.stream).toBe(TICKET_INTERNAL_STREAM)
    expect(sent.stream).toBe('outbound')
  })

  it('logs the INTERNAL stream to email_sends, never Postmark’s id', async () => {
    await post(T_STUDIO.id, { text: 'We open at 6.' })
    const [send] = insertsInto(db, 'email_sends')
    expect(send.payload.postmark_stream).toBe('outbound')
    expect(send.payload.postmark_stream).not.toBe('email-send')
  })

  it('503s without sending when the ticketing server is not configured', async () => {
    delete process.env.POSTMARK_EMAIL_INBOX_SERVER_TOKEN
    const res = await post(T_STUDIO.id, { text: 'We open at 6.' })

    expect(res.status).toBe(503)
    expect((await res.json()).error).toContain('POSTMARK_EMAIL_INBOX_SERVER_TOKEN')
    // It must NOT quietly leave on the marketing server instead.
    expect(sendEmail).not.toHaveBeenCalled()
    // And nothing is written — the ticket does not claim to have been answered.
    expect(insertsInto(db, 'email_inbox_messages')).toHaveLength(0)
    expect(updatesTo(db, 'email_tickets')).toHaveLength(0)
  })

  it('records the mailbox address as the From on both rows', async () => {
    await post(T_STUDIO.id, { text: 'We open at 6.' })
    const [msg] = insertsInto(db, 'email_inbox_messages')
    const [send] = insertsInto(db, 'email_sends')
    expect(msg.payload.from_email).toBe(MB_STUDIO.address)
    expect(send.payload.from_email).toBe(MB_STUDIO.address)
  })

  it('falls back to a domain we own when the mailbox cannot be sent from', async () => {
    const rejection = Object.assign(new Error('no Sender Signature'), { errorCode: 400, httpStatus: 422 })
    sendEmail.mockRejectedValueOnce(rejection).mockResolvedValue({ messageId: 'pm-fallback' })

    const res = await post(T_STUDIO.id, { text: 'We open at 6.' })

    expect(res.status).toBe(200)
    expect(sendEmail).toHaveBeenCalledTimes(2)
    // Reply-To still points at the real mailbox, so the thread survives.
    expect(sendEmail.mock.calls[1][0].replyTo).toBe(MB_STUDIO.address)
    expect(sendEmail.mock.calls[1][0].sender.fromEmail).toBe('UN1T <hello@un1t.ie>')
    // The row records what actually went out, not what we hoped would.
    const [msg] = insertsInto(db, 'email_inbox_messages')
    expect(msg.payload.from_email).toBe('UN1T <hello@un1t.ie>')
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
    // an author field. Since EMAIL-OUTBOUND-SERVER.1 that is the mailbox's own
    // address, which makes the distinction visible rather than theoretical.
    expect(msg.payload.author_profile_id).toBe(COACH.id)
    expect(msg.payload.from_email).toBe(MB_STUDIO.address)
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

describe('POST …/reply — the legacy mirror is GONE (EMAIL-CONV-STOP.1)', () => {
  it('leaves email_conversations alone even when the ticket HAS one', async () => {
    setupDb(baseState({ grants: [GRANT_STUDIO], messages: [LAST_INBOUND_DUAL] }))
    const res = await post(T_STUDIO.id, { text: 'We open at 6.' })
    expect(res.status).toBe(200)

    expect(updatesTo(db, 'email_conversations')).toHaveLength(0)
    expect(insertsInto(db, 'email_conversations')).toHaveLength(0)
    // The mirror also back-stamped conversation_id onto the row it had just
    // inserted. The reply is written once, with ticket_id only.
    expect(insertsInto(db, 'email_inbox_messages')).toHaveLength(1)
    expect(insertsInto(db, 'email_inbox_messages')[0].payload).not.toHaveProperty('conversation_id')
    expect(updatesTo(db, 'email_inbox_messages')).toHaveLength(0)
  })

  it('never reads the table looking for one', async () => {
    setupDb(baseState({ grants: [GRANT_STUDIO], messages: [LAST_INBOUND_DUAL] }))
    const reads = []
    const realFrom = db.from
    db.from = (table) => { reads.push(table); return realFrom(table) }

    await post(T_STUDIO.id, { text: 'We open at 6.' })

    expect(reads).not.toContain('email_conversations')
  })

  it('drops conversation_id from the response payload', async () => {
    setupDb(baseState({ grants: [GRANT_STUDIO], messages: [LAST_INBOUND_DUAL] }))
    const res = await post(T_STUDIO.id, { text: 'We open at 6.' })
    const { data } = await res.json()
    expect(data).not.toHaveProperty('conversation_id')
    expect(data).toMatchObject({ status: 'pending', message_id: 'pm-out-1' })
  })

  it('answers the member with the table entirely unavailable', async () => {
    // What a dropped email_conversations looks like from here. The mirror was
    // already non-fatal, so this asserts the stronger property: the route does
    // not go near it at all, so there is nothing to swallow an error from.
    setupDb(baseState({ grants: [GRANT_STUDIO], messages: [LAST_INBOUND_DUAL] }))
    const realFrom = db.from
    db.from = (table) => {
      if (table === 'email_conversations') throw new Error('relation "public.email_conversations" does not exist')
      return realFrom(table)
    }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await post(T_STUDIO.id, { text: 'We open at 6.' })

    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect(insertsInto(db, 'email_inbox_messages')).toHaveLength(1)
    expect(updatesTo(db, 'email_tickets')).toHaveLength(1)
    // …and nothing had to be logged and swallowed to get there.
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })
})

// EMAIL-TICKET.6 — the threading lookup no longer swallows its error.
describe('POST …/reply — query failures are loud', () => {
  it('500s BEFORE sending when the threading lookup errors', async () => {
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      messages: [LAST_INBOUND],
      errors: { email_inbox_messages: { code: '42703', message: 'column rfc_message_id does not exist' } },
    }))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await post(T_STUDIO.id, { text: 'We open at 6.' })

    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
    // The whole point of failing HERE: the ordering means nothing went out, so
    // there is no half-sent reply to reconcile.
    expect(sendEmail).not.toHaveBeenCalled()
    expect(errors).toHaveBeenCalled()
    errors.mockRestore()
  })
})

// EMAIL-TICKET-CLEANUP.1 — the permission follows the TICKET'S location.
//
// Of the routes that carried the active-location gate, this is the one where
// getting it wrong wrote to the OUTSIDE WORLD: a manager at one studio who is
// merely staff at another could send real mail, from the second studio's
// correspondence, over a key they hold somewhere else entirely. Reading the
// wrong ticket is a leak; answering it as the business is a forgery.
//
// ONE user, TWO studios, opposite answers, real resolver. They are assigned to
// both and hold a mailbox grant at both, so the location and per-account gates
// pass either way — only the surface key separates these two cases.
describe('POST …/reply — the permission follows the TICKET’S location', () => {
  beforeEach(() => {
    getCurrentUser.mockResolvedValue(MULTI_LOCATION)
    setupDb(baseState({
      tickets: [{ ...T_STUDIO }, { ...T_ACCOUNTS }, { ...T_OTHER_LOCATION }],
      grants: [GRANT_MULTI_STUDIO, GRANT_MULTI_OTHER_LOCATION],
      messages: [LAST_INBOUND],
    }))
  })

  it('ALLOWS a reply at the studio where they hold the key', async () => {
    // The wrongly-DENIED direction: the old gate read an active location this
    // user does not have and refused their own studio's queue outright.
    expect((await post(T_STUDIO.id, { text: 'hi' })).status).toBe(200)
    expect(sendEmail).toHaveBeenCalledTimes(1)
  })

  it('DENIES a reply at the studio where they do not — nothing sent, nothing written', async () => {
    // The direction that forges mail. 404 like every other refusal here, and
    // the assertion that matters is sendEmail: a 404 that had already put a
    // message on the wire would be worse than no gate at all.
    expect((await post(T_OTHER_LOCATION.id, { text: 'hi' })).status).toBe(404)
    expect(sendEmail).not.toHaveBeenCalled()
    expect(writesTo(db)).toEqual([])
  })

  it('DENIES an INTERNAL NOTE there too — the note branch is not a side door', async () => {
    // The internal-note branch returns long before the send, so it would have
    // been easy to leave ungated. A note is staff-to-staff correspondence on
    // another studio's ticket; it is not less private for never being emailed.
    expect((await post(T_OTHER_LOCATION.id, { text: 'fyi', internal: true })).status).toBe(404)
    expect(writesTo(db)).toEqual([])
  })
})

// EMAIL-TICKET-CLEANUP.2 — a FAILED visibility lookup is not "no mailboxes".
describe('POST …/reply — a failed mailbox lookup is not an empty one', () => {
  it('500s instead of 404ing, and sends nothing', async () => {
    // NOTHING HAS BEEN SENT at this point, so refusing costs a retry and can
    // never produce a wrong outcome — the same ordering argument that makes 500
    // safe for the threading lookup below.
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      messages: [LAST_INBOUND],
      errors: { email_mailboxes: { code: '42703', message: 'column does not exist' } },
    }))
    expect((await post(T_STUDIO.id, { text: 'hi' })).status).toBe(500)
    expect(sendEmail).not.toHaveBeenCalled()
    expect(writesTo(db)).toEqual([])
  })
})

// ── EMAIL-OUTBOUND-ATTACH.1 ─────────────────────────────────────────
// Staff can now attach files to a reply. The property that matters most is the
// ORDERING: every way an attachment can be refused has to be a refusal to send
// AT ALL, because a thread showing a reply that claims files the member never
// received is exactly the lie this feature is built to avoid.
describe('POST …/reply — attachments', () => {
  const DRAFT = '22222222-2222-4222-8222-222222222222'
  const draftRef = (index, mime = 'application/pdf', filename = 'invoice.pdf') =>
    ({ draft_id: DRAFT, index, filename, mime })

  function seedDraft(index, { mime = 'application/pdf', bytes = 'hello world' } = {}) {
    const path = outboundDraftPath({ profileId: COACH.id, draftId: DRAFT, index, mime })
    seedObject(db, EMAIL_ATTACHMENT_BUCKET, path, bytes)
    return path
  }

  it('puts the file on the wire in Postmark’s own shape and files it on the thread', async () => {
    seedDraft(0)
    const res = await post(T_STUDIO.id, { text: 'Here you go.', attachments: [draftRef(0)] })
    expect(res.status).toBe(200)

    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [{
        Name: 'invoice.pdf',
        Content: Buffer.from('hello world').toString('base64'),
        ContentType: 'application/pdf',
      }],
    }))

    const [att] = insertsInto(db, 'email_ticket_attachments')
    expect(att.payload).toMatchObject({
      location_id: T_STUDIO.location_id,
      mailbox_id: T_STUDIO.mailbox_id,
      attachment_index: 0,
      filename: 'invoice.pdf',
      mime_type: 'application/pdf',
      size_bytes: 11,
      skipped_reason: null,
    })
    // Recorded against the OUTBOUND MESSAGE ROW that was just written, which is
    // what makes the thread render it with exactly the chip an inbound
    // attachment gets — same table, same shape, same download route.
    const messageId = db._state.messages.find(m => m.direction === 'outbound')?.id
    expect(messageId).toBeTruthy()
    expect(att.payload.message_id).toBe(messageId)
    // …and the bytes now live at the canonical <location>/<message>/<i>.<ext>
    // key, not the draft one.
    expect(att.payload.storage_path).toBe(`${T_STUDIO.location_id}/${messageId}/0.pdf`)
    expect(objectKeys(db)).toEqual([`${EMAIL_ATTACHMENT_BUCKET}/${att.payload.storage_path}`])
  })

  it('sends NO Attachments key at all when there are none', async () => {
    await post(T_STUDIO.id, { text: 'no files here' })
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ attachments: undefined }))
    expect(insertsInto(db, 'email_ticket_attachments')).toEqual([])
  })

  it('REFUSES 400 when a draft cannot be read — nothing sent, nothing written', async () => {
    const res = await post(T_STUDIO.id, { text: 'Here you go.', attachments: [draftRef(0)] })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('Nothing was sent')
    expect(sendEmail).not.toHaveBeenCalled()
    // THE WHOLE POINT: the ticket does not advance and the thread shows nothing.
    expect(writesTo(db)).toEqual([])
  })

  it('REFUSES 400 past the size ceiling — before the send, naming the limit', async () => {
    seedDraft(0, { bytes: Buffer.alloc(4 * 1024 * 1024, 1) })
    seedDraft(1, { bytes: Buffer.alloc(4 * 1024 * 1024, 1) })
    const res = await post(T_STUDIO.id, {
      text: 'Two big ones.', attachments: [draftRef(0), draftRef(1)],
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('7.0 MB')
    expect(sendEmail).not.toHaveBeenCalled()
    expect(writesTo(db)).toEqual([])
  })

  it('cannot reach ANOTHER staff member’s draft', async () => {
    // Uploaded by someone else; the key is rebuilt under the CALLER'S profile
    // id, so this addresses a path that has never existed.
    const foreign = outboundDraftPath({ profileId: 'profile-someone-else', draftId: DRAFT, index: 0, mime: 'application/pdf' })
    seedObject(db, EMAIL_ATTACHMENT_BUCKET, foreign, 'secret')
    const res = await post(T_STUDIO.id, { text: 'gimme', attachments: [draftRef(0)] })
    expect(res.status).toBe(400)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('a send that FAILS leaves the thread with no attachment row and no ticket move', async () => {
    seedDraft(0)
    sendEmail.mockRejectedValue(new Error('Postmark said no'))
    const res = await post(T_STUDIO.id, { text: 'Here you go.', attachments: [draftRef(0)] })
    expect(res.status).toBe(400)
    expect(writesTo(db)).toEqual([])
    // The draft object survives, deliberately — the operator's retry needs it.
    expect(objectKeys(db)).toEqual([
      `${EMAIL_ATTACHMENT_BUCKET}/${outboundDraftPath({ profileId: COACH.id, draftId: DRAFT, index: 0, mime: 'application/pdf' })}`,
    ])
  })

  it('REFUSES files on an internal note rather than silently dropping them', async () => {
    seedDraft(0)
    const res = await post(T_STUDIO.id, { text: 'fyi', internal: true, attachments: [draftRef(0)] })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('internal note')
    expect(writesTo(db)).toEqual([])
  })

  it('400s on more than ten files, before any Storage work', async () => {
    const many = Array.from({ length: 11 }, (_, i) => draftRef(i % 10))
    const res = await post(T_STUDIO.id, { text: 'lots', attachments: many })
    expect(res.status).toBe(400)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('a FULL mailbox still sends the file, and the thread says the copy was not kept', async () => {
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      messages: [LAST_INBOUND],
      storageUsage: [{
        location_id: T_STUDIO.location_id, mailbox_id: T_STUDIO.mailbox_id,
        bytes_used: 5 * 1024 * 1024 * 1024, quota_bytes: 5 * 1024 * 1024 * 1024,
      }],
    }))
    seedDraft(0)

    const res = await post(T_STUDIO.id, { text: 'Here you go.', attachments: [draftRef(0)] })
    expect(res.status).toBe(200)
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [expect.objectContaining({ Name: 'invoice.pdf' })],
    }))
    const [att] = insertsInto(db, 'email_ticket_attachments')
    expect(att.payload.storage_path).toBeNull()
    expect(att.payload.skipped_reason).toBe('quota')
  })

  it('filing that fails NEVER fails the response — the email already went', async () => {
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      messages: [LAST_INBOUND],
      errors: { email_ticket_attachments: { code: '42703', message: 'no such column' } },
    }))
    seedDraft(0)
    const res = await post(T_STUDIO.id, { text: 'Here you go.', attachments: [draftRef(0)] })
    expect(res.status).toBe(200)
  })
})

// ── EMAIL-CC.1 — WHO A REPLY REACHES ─────────────────────────────────
//
// The rule under test (Richard, 2026-08-07): the recipient set is DERIVED, not
// chosen. Reply = one person, Reply All = everybody on the thread, and there is
// no wire format for the difference — a caller cannot ask to drop a
// participant, which is the whole point.
//
// `sendEmail` is mocked, so every assertion here is on the exact payload that
// would have gone to Postmark. That is the only place a leak would be visible
// from outside this route.
const CC_INBOUND = {
  ...LAST_INBOUND,
  id: 'm-cc-1',
  from_email: 'member@example.com',
  to_email: MB_STUDIO.address,
  to_emails: [MB_STUDIO.address],
  cc_emails: ['colleague@example.com', 'boss@example.com'],
  bcc_emails: [],
}

describe('POST …/reply — the derived recipient set', () => {
  it('replies to ONE person when one person is on the thread', async () => {
    const res = await post(T_STUDIO.id, { text: 'hi' })
    expect(res.status).toBe(200)
    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect(sendEmail.mock.calls[0][0]).toMatchObject({ to: 'member@example.com' })
    expect((await res.json()).data.mode).toBe('reply')
  })

  // The behaviour the feature exists for: a member cc'd two colleagues, and a
  // reply that reached only the sender would drop them out of their own
  // conversation.
  it('replies to EVERYBODY on the thread when the member cc’d colleagues', async () => {
    setupDb(baseState({ grants: [GRANT_STUDIO], messages: [CC_INBOUND] }))
    const res = await post(T_STUDIO.id, { text: 'hi' })
    expect(res.status).toBe(200)
    const sent = sendEmail.mock.calls[0][0]
    expect(sent.to).toBe('member@example.com, colleague@example.com, boss@example.com')
    expect((await res.json()).data.mode).toBe('reply_all')
  })

  // Our own mailbox is necessarily in the inbound To — the member wrote to it.
  // Mailing it delivers our own reply back to our own inbound webhook, which
  // files it on THIS ticket as an inbound message: the ticket reopens and the
  // needs-reply badge lights up for mail nobody sent us.
  it('never writes to the studio’s own mailbox, which the inbound To always contains', async () => {
    setupDb(baseState({ grants: [GRANT_STUDIO], messages: [CC_INBOUND] }))
    await post(T_STUDIO.id, { text: 'hi' })
    const sent = sendEmail.mock.calls[0][0]
    expect(sent.to).not.toContain(MB_STUDIO.address)
    expect(sent.cc || '').not.toContain(MB_STUDIO.address)
  })

  it('never writes to the Postmark From either', async () => {
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      messages: [{ ...CC_INBOUND, cc_emails: ['hello@un1t.ie', 'colleague@example.com'] }],
    }))
    await post(T_STUDIO.id, { text: 'hi' })
    expect(sendEmail.mock.calls[0][0].to).toBe('member@example.com, colleague@example.com')
  })

  // …and never to a SISTER STUDIO's mailbox (2026-08-08 audit). The exclusion
  // set is estate-wide, not per-location: a member who wrote to accounts@ here
  // and cc'd another studio's address would otherwise get our reply-all
  // delivered into THAT studio's inbound webhook, where nothing threads
  // (threading is location-scoped) — so it mints a brand-new "inbound" ticket
  // from our own address, once per reply-all, forever.
  it('never writes to another studio’s mailbox — the exclusion set is estate-wide', async () => {
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      messages: [{ ...CC_INBOUND, cc_emails: [MB_OTHER_LOCATION.address, 'colleague@example.com'] }],
    }))
    await post(T_STUDIO.id, { text: 'hi' })
    const sent = sendEmail.mock.calls[0][0]
    expect(sent.to).toBe('member@example.com, colleague@example.com')
    expect(sent.to).not.toContain(MB_OTHER_LOCATION.address)
    expect(sent.cc || '').not.toContain(MB_OTHER_LOCATION.address)
  })

  // WAS 'follows the LATEST message — a participant dropped later is not
  // resurrected', asserting `to` WITHOUT boss@ (EMAIL-PARTICIPANTS.5 inverted
  // it). That expectation encoded the defect: it read a person's absence from
  // the newest message as an intention to drop them, and the live 2026-08-12
  // failure is what that inference costs — a shared council mailbox opened a
  // thread, one officer answered from her own address, and the reply reached
  // her alone. A mail client cannot distinguish "deliberately removed" from
  // "did not happen to be on the last message", so it must not guess. Someone
  // genuinely finished with a thread comes off it through excluded_participants
  // — the test directly below.
  const THREAD_LOSING_BOSS = [
    { ...CC_INBOUND, id: 'm-old', created_at: '2026-08-06T09:00:00Z' },
    {
      ...CC_INBOUND, id: 'm-new', created_at: '2026-08-06T12:00:00Z',
      cc_emails: ['colleague@example.com'],
    },
  ]

  it('KEEPS a participant who is on an earlier message but not the newest', async () => {
    setupDb(baseState({ grants: [GRANT_STUDIO], messages: THREAD_LOSING_BOSS }))
    await post(T_STUDIO.id, { text: 'hi' })
    expect(sendEmail.mock.calls[0][0].to)
      .toBe('member@example.com, colleague@example.com, boss@example.com')
  })

  // …and THIS is how someone actually comes off a thread now: an operator says
  // so, on the ticket (mig 534). A visible act with an undo, rather than a
  // derivation rule nobody can see. The guarantee the inverted test above used
  // to carry — "a person can be dropped from the audience" — lives here.
  it('drops exactly the participant an operator removed, and nobody else', async () => {
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      tickets: [{ ...T_STUDIO, excluded_participants: ['boss@example.com'] }, { ...T_ACCOUNTS }],
      messages: THREAD_LOSING_BOSS,
    }))
    await post(T_STUDIO.id, { text: 'hi' })
    expect(sendEmail.mock.calls[0][0].to).toBe('member@example.com, colleague@example.com')
  })

  // A thread that ends in a run of staff notes still has correspondence behind
  // it; a scan that stopped at the first note would silently narrow the reply.
  it('looks past trailing internal notes to find the real correspondence', async () => {
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      messages: [
        CC_INBOUND,
        {
          id: 'm-note', ticket_id: T_STUDIO.id, location_id: T_STUDIO.location_id,
          direction: 'outbound', is_internal_note: true, from_email: 'coach@un1tdublin.com',
          to_email: null, to_emails: [], cc_emails: [], created_at: '2026-08-06T13:00:00Z',
        },
      ],
    }))
    await post(T_STUDIO.id, { text: 'hi' })
    expect(sendEmail.mock.calls[0][0].to)
      .toBe('member@example.com, colleague@example.com, boss@example.com')
  })

  // A composed ticket nobody has answered yet has no inbound at all. One rule
  // has to cover both directions or this is a special case nobody tested.
  it('derives the set from our OWN last outbound when nobody has replied yet', async () => {
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      messages: [{
        id: 'm-out', ticket_id: T_STUDIO.id, location_id: T_STUDIO.location_id,
        direction: 'outbound', is_internal_note: false,
        from_email: 'hello@un1t.ie', to_email: 'member@example.com',
        to_emails: ['member@example.com'], cc_emails: ['colleague@example.com'],
        bcc_emails: [], created_at: '2026-08-06T09:00:00Z',
      }],
    }))
    await post(T_STUDIO.id, { text: 'hi' })
    expect(sendEmail.mock.calls[0][0].to).toBe('member@example.com, colleague@example.com')
  })

  it('falls back to the requester when a ticket has no usable correspondence', async () => {
    setupDb(baseState({ grants: [GRANT_STUDIO], messages: [] }))
    await post(T_STUDIO.id, { text: 'hi' })
    expect(sendEmail.mock.calls[0][0].to).toBe('member@example.com')
  })

  // Nothing has been sent at this point, so refusing costs a retry. Quietly
  // narrowing to the requester would look like a successful reply while
  // dropping everyone else on the thread.
  it('500s rather than narrowing the reply when the recipient lookup fails', async () => {
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      messages: [CC_INBOUND],
      errors: { email_inbox_messages: { code: '42703', message: 'column does not exist' } },
    }))
    expect((await post(T_STUDIO.id, { text: 'hi' })).status).toBe(500)
    expect(sendEmail).not.toHaveBeenCalled()
  })
})

// ── EMAIL-PARTICIPANTS.5 — THE SEND REACHES THE WHOLE THREAD ─────────
//
// The live failure of 2026-08-12: a shared council mailbox opened a thread, a
// named officer in that office answered from her own address, and the staff
// reply reached her ALONE. Nobody saw a dropped recipient — the reply simply
// never arrived at the mailbox that had asked the question, because the
// audience was derived from the NEWEST message only, so whoever wrote last
// silently redefined who the conversation was with.
//
// EMAIL-PARTICIPANTS.4 fixed the LABEL (the detail route's reply_recipients).
// This block is the half that puts real mail on the wire, and it is the one
// that actually decides who gets the email.
describe('POST …/reply — the audience is the whole thread (EMAIL-PARTICIPANTS.5)', () => {
  const OPENED_TO_SHARED_MAILBOX = {
    id: 'm-rates', ticket_id: T_STUDIO.id, location_id: T_STUDIO.location_id,
    direction: 'outbound', is_internal_note: false, forwarded_message_id: null,
    from_email: MB_STUDIO.address,
    to_email: 'rates@council.ie', to_emails: ['rates@council.ie'],
    cc_emails: [], bcc_emails: [],
    created_at: '2026-08-12T09:10:00Z',
  }
  const ANSWERED_BY_ONE_OFFICER = {
    id: 'm-eleanor', ticket_id: T_STUDIO.id, location_id: T_STUDIO.location_id,
    direction: 'inbound', is_internal_note: false, forwarded_message_id: null,
    from_email: 'eleanor@council.ie',
    to_email: MB_STUDIO.address, to_emails: [MB_STUDIO.address],
    cc_emails: [], bcc_emails: [],
    created_at: '2026-08-12T10:06:00Z',
  }

  it('sends to EVERYONE on the thread, not just the newest correspondent', async () => {
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      messages: [OPENED_TO_SHARED_MAILBOX, ANSWERED_BY_ONE_OFFICER],
    }))
    const res = await post(T_STUDIO.id, { text: 'Thanks — noted.' })
    expect(res.status).toBe(200)

    const sent = sendEmail.mock.calls[0][0]
    // The officer who wrote last…
    expect(sent.to).toContain('eleanor@council.ie')
    // …and the shared mailbox that opened it. THIS is the address the live bug
    // dropped, silently, on a reply the operator watched succeed.
    expect(sent.to).toContain('rates@council.ie')
    // Our own address is still never written to — a reply-all that mailed
    // studio@ re-enters our own inbound webhook and files onto this ticket.
    expect(sent.to).not.toContain(MB_STUDIO.address)
    // …and the row records the same set the wire carried.
    const [msg] = insertsInto(db, 'email_inbox_messages')
    expect(msg.payload.to_emails).toEqual(['eleanor@council.ie', 'rates@council.ie'])
  })

  // The other half of a wider audience: it can now be EMPTY, and it can now
  // exceed the cap. Both are refused BEFORE the send, where a 400 costs a retry
  // and nothing else — the alternative to each is a send that silently reaches
  // the wrong set, which is the failure this whole programme exists to end.
  it('400s rather than sending when every participant has been removed', async () => {
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      // The operator took the only correspondent off this ticket (mig 534).
      // Mailing them anyway is not an acceptable way to avoid an error message.
      tickets: [{ ...T_STUDIO, excluded_participants: ['member@example.com'] }, { ...T_ACCOUNTS }],
      messages: [{
        id: 'm-only', ticket_id: T_STUDIO.id, location_id: T_STUDIO.location_id,
        direction: 'inbound', is_internal_note: false, forwarded_message_id: null,
        from_email: 'member@example.com',
        to_email: MB_STUDIO.address, to_emails: [MB_STUDIO.address],
        cc_emails: [], bcc_emails: [], created_at: '2026-08-12T09:00:00Z',
      }],
    }))
    const res = await post(T_STUDIO.id, { text: 'hello' })

    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/no recipients/i)
    // THE HALF THAT MATTERS: a 400 that had already mailed the person the
    // operator removed would be worse than no check at all.
    expect(sendEmail).not.toHaveBeenCalled()
    expect(writesTo(db)).toEqual([])
  })

  it('400s rather than truncating when the audience exceeds the cap', async () => {
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      messages: Array.from({ length: 30 }, (_, i) => ({
        id: `m-${i}`, ticket_id: T_STUDIO.id, location_id: T_STUDIO.location_id,
        direction: 'inbound', is_internal_note: false, forwarded_message_id: null,
        from_email: `p${i}@example.com`,
        to_email: MB_STUDIO.address, to_emails: [MB_STUDIO.address],
        cc_emails: [], bcc_emails: [],
        created_at: `2026-08-12T09:00:${String(i).padStart(2, '0')}Z`,
      })),
    }))
    const res = await post(T_STUDIO.id, { text: 'hello' })

    expect(res.status).toBe(400)
    const { error } = await res.json()
    expect(error).toMatch(/30 recipients/)
    expect(error).toMatch(/limit is 25/)
    // Silently sending to the first 25 is the outcome the refusal exists to
    // prevent — five people dropped, and nothing on screen saying so.
    expect(sendEmail).not.toHaveBeenCalled()
    expect(writesTo(db)).toEqual([])
  })
})

// ── THE BCC GUARANTEE, AT THE ROUTE ──────────────────────────────────
//
// email-recipients.test.js mutation-checks the pure function. These prove the
// ROUTE wires it up: a bcc stored on this ticket's own history must not appear
// anywhere in the next reply's payload, and a bcc the operator types must
// reach Postmark's Bcc field and nothing else.
describe('POST …/reply — bcc never leaks', () => {
  const OUTBOUND_WITH_BCC = {
    id: 'm-bcc', ticket_id: T_STUDIO.id, location_id: T_STUDIO.location_id,
    direction: 'outbound', is_internal_note: false,
    from_email: 'hello@un1t.ie', to_email: 'member@example.com',
    to_emails: ['member@example.com'], cc_emails: ['colleague@example.com'],
    bcc_emails: ['secret@example.com'], created_at: '2026-08-06T10:00:00Z',
  }

  it('does NOT re-copy an address this ticket was previously blind-copied to', async () => {
    setupDb(baseState({ grants: [GRANT_STUDIO], messages: [OUTBOUND_WITH_BCC] }))
    await post(T_STUDIO.id, { text: 'follow up' })
    const sent = sendEmail.mock.calls[0][0]
    expect(JSON.stringify(sent)).not.toContain('secret@example.com')
    expect(sent.to).toBe('member@example.com, colleague@example.com')
    expect(sent.bcc).toBeUndefined()
  })

  it('puts a hand-typed bcc in Postmark’s Bcc field and NOWHERE else', async () => {
    await post(T_STUDIO.id, { text: 'hi', bcc: ['boss@example.com'] })
    const sent = sendEmail.mock.calls[0][0]
    expect(sent.bcc).toBe('boss@example.com')
    expect(sent.to).not.toContain('boss@example.com')
    expect(sent.cc || '').not.toContain('boss@example.com')
    // Threading headers are the only extra headers this route sets, and a bcc
    // address must never ride in one.
    expect(JSON.stringify(sent.headers || [])).not.toContain('boss@example.com')
  })

  // BELT AND BRACES, and worth its own test: the route does not even ASK for
  // bcc_emails when it works out who to write to. A future edit to
  // ticketParticipants() that started reading the column would find it absent
  // rather than populated — the leak is unreachable from two directions, not
  // one.
  it('never SELECTS bcc_emails on the recipient lookup', async () => {
    await post(T_STUDIO.id, { text: 'hi' })
    const scans = selectsFrom(db, 'email_inbox_messages')
    for (const scan of scans) expect(scan.columns).not.toContain('bcc_emails')
    // …while still asking for everything a participant set is built from.
    const recipientScan = scans.find(sc => sc.columns.includes('cc_emails'))
    expect(recipientScan.columns).toContain('from_email')
    expect(recipientScan.columns).toContain('to_emails')
  })

  it('stores the bcc on the message row for the staff thread', async () => {
    await post(T_STUDIO.id, { text: 'hi', bcc: ['boss@example.com'] })
    const [msg] = insertsInto(db, 'email_inbox_messages')
    expect(msg.payload.bcc_emails).toEqual(['boss@example.com'])
    expect(msg.payload.cc_emails).toEqual([])
  })
})

describe('POST …/reply — added recipients', () => {
  it('adds a Cc on top of the thread’s own participants', async () => {
    setupDb(baseState({ grants: [GRANT_STUDIO], messages: [CC_INBOUND] }))
    await post(T_STUDIO.id, { text: 'hi', cc: ['newperson@example.com'] })
    const sent = sendEmail.mock.calls[0][0]
    expect(sent.to).toBe('member@example.com, colleague@example.com, boss@example.com')
    expect(sent.cc).toBe('newperson@example.com')
  })

  // THE SECOND ENFORCEMENT SITE. ticketParticipants() already drops our own
  // addresses out of the DERIVED set, so the tests above pass with or without
  // the `exclude` on resolveRecipients — the one thing only resolveRecipients
  // can catch is an operator TYPING one of our mailboxes into Cc/Bcc. Same
  // consequence as a derived one: Postmark delivers the copy to our own
  // inbound webhook, whose In-Reply-To still names this thread, so our own
  // reply is filed on this ticket as INBOUND and lights the needs-reply badge.
  // Mutation-checked — deleting `exclude: own.addresses` turns this red and
  // nothing else on the route.
  it('strips a HAND-TYPED address of ours from every list', async () => {
    setupDb(baseState({ grants: [GRANT_STUDIO], messages: [CC_INBOUND] }))
    await post(T_STUDIO.id, {
      text: 'hi',
      cc: [MB_STUDIO.address, 'newperson@example.com'],
      bcc: ['hello@un1t.ie'],
    })
    const sent = sendEmail.mock.calls[0][0]
    expect(sent.cc).toBe('newperson@example.com')
    expect(sent.bcc).toBeUndefined()
    // Reply-To is deliberately still the mailbox — that is the address the
    // member answers to, not somewhere we WRITE to.
    expect(sent.to).not.toContain(MB_STUDIO.address)
    expect(sent.replyTo).toBe(MB_STUDIO.address)
    const [msg] = insertsInto(db, 'email_inbox_messages')
    expect(msg.payload.cc_emails).toEqual(['newperson@example.com'])
    expect(msg.payload.bcc_emails).toEqual([])
  })

  // The dedupe the brief names: the member's own address must not end up in Cc
  // as well as To.
  it('drops a Cc that is already a thread participant, case-insensitively', async () => {
    setupDb(baseState({ grants: [GRANT_STUDIO], messages: [CC_INBOUND] }))
    await post(T_STUDIO.id, { text: 'hi', cc: ['MEMBER@example.com', 'Colleague@Example.com'] })
    expect(sendEmail.mock.calls[0][0].cc).toBeUndefined()
  })

  it('writes to_emails, cc_emails and to_email consistently', async () => {
    setupDb(baseState({ grants: [GRANT_STUDIO], messages: [CC_INBOUND] }))
    await post(T_STUDIO.id, { text: 'hi', cc: ['newperson@example.com'] })
    const [msg] = insertsInto(db, 'email_inbox_messages')
    expect(msg.payload.to_emails)
      .toEqual(['member@example.com', 'colleague@example.com', 'boss@example.com'])
    expect(msg.payload.to_email).toBe('member@example.com')
    expect(msg.payload.cc_emails).toEqual(['newperson@example.com'])
  })

  // email_sends is the per-contact email history and contact_id is NOT NULL —
  // inventing rows for cc'd colleagues would put mail in strangers' histories.
  it('logs ONE email_sends row, for the ticket’s own contact', async () => {
    setupDb(baseState({ grants: [GRANT_STUDIO], messages: [CC_INBOUND] }))
    await post(T_STUDIO.id, { text: 'hi', cc: ['newperson@example.com'] })
    const sends = insertsInto(db, 'email_sends')
    expect(sends).toHaveLength(1)
    expect(sends[0].payload.to_email).toBe('member@example.com')
  })

  // THE "ADDING A STRANGER" ANSWER. There is no consent gate on ticket mail by
  // design, so instead the act is attributable: an address nobody on the
  // thread involved carries the sender's name at the moment they added it.
  it('audit-logs an address the operator added that nobody on the thread involved', async () => {
    setupDb(baseState({ grants: [GRANT_STUDIO], messages: [CC_INBOUND] }))
    await post(T_STUDIO.id, { text: 'hi', cc: ['stranger@example.com'] })
    const [audit] = insertsInto(db, 'audit_events')
    expect(audit.payload).toMatchObject({
      action: 'email_ticket.recipients_added',
      actor_id: COACH.id,
      location_id: T_STUDIO.location_id,
    })
    expect(audit.payload.details.added).toEqual(['stranger@example.com'])
  })

  // Reply-all reaches only people the MEMBER put on the thread. That is not
  // someone being added, and logging it would bury the entries that matter.
  it('does NOT audit-log a plain reply-all — nobody was added', async () => {
    setupDb(baseState({ grants: [GRANT_STUDIO], messages: [CC_INBOUND] }))
    await post(T_STUDIO.id, { text: 'hi' })
    expect(insertsInto(db, 'audit_events')).toEqual([])
  })

  it('400s on an invalid address, sending nothing', async () => {
    const res = await post(T_STUDIO.id, { text: 'hi', cc: ['not-an-address'] })
    expect(res.status).toBe(400)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  // The cap is enforced SERVER-SIDE, past the composer's own limit.
  it('400s past the recipient cap, sending nothing', async () => {
    const many = Array.from({ length: 25 }, (_, i) => `c${i}@example.com`)
    const res = await post(T_STUDIO.id, { text: 'hi', cc: many })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/limit is 25/)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('rejects an absurd array at parse time rather than normalising it', async () => {
    const absurd = Array.from({ length: 5000 }, (_, i) => `c${i}@example.com`)
    expect((await post(T_STUDIO.id, { text: 'hi', cc: absurd })).status).toBe(400)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  // A note is sent to nobody. Swallowing the addresses would let an operator
  // believe those people were copied on something never sent at all.
  it('REFUSES an internal note that carries recipients, writing nothing', async () => {
    const res = await post(T_STUDIO.id, { text: 'fyi', internal: true, cc: ['boss@example.com'] })
    expect(res.status).toBe(400)
    expect(writesTo(db)).toEqual([])
    expect(sendEmail).not.toHaveBeenCalled()
  })
})

// ── EMAIL-REPLY-UNFILED.1 — the message insert fails AFTER the send ──
//
// Everything above refuses BEFORE Postmark is called, where a 500 costs a
// retry and nothing else. This block is the other side of that line: the send
// succeeded, the filing insert did not. The member HAS the reply, so the one
// answer the route must not give is the generic DB-error 500 an operator reads
// as "it failed — send it again": that retry is a real second email in a real
// inbox. The compose route learned this first and answers with explicit copy;
// these pin the reply route to the same behaviour, plus breadcrumbs — the
// delivered send has to be recorded SOMEWHERE a human can find it, because the
// message row that should have been its record does not exist.

// `failWrites` (shared harness, ../../_test-db.js) fails WRITES only —
// `state.errors` would fail the threading lookup too, and the route would then
// refuse before sending, which is precisely not the case under test.

describe('POST …/reply — filing fails AFTER the send (EMAIL-REPLY-UNFILED.1)', () => {
  let errors
  beforeEach(() => {
    errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => errors.mockRestore())

  it('says the mail is ALREADY SENT — never the raw DB error an operator reads as "try again"', async () => {
    failWrites(db, ['email_inbox_messages'])
    const res = await post(T_STUDIO.id, { text: 'We open at 6.' })

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toMatch(/was sent/i)
    expect(body.error).toMatch(/do not resend/i)
    expect(body.error).not.toContain('write exploded')
    // Machine-readable too, so the composer can tell this 500 from every
    // other 500 without string-matching the copy.
    expect(body.data).toMatchObject({ sent: true, message_id: 'pm-out-1' })
    // Exactly one send — the route must never retry its way into the double
    // this response exists to prevent.
    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect(errors).toHaveBeenCalled()
  })

  it('records the delivered send as a dead letter, at the ticket’s location', async () => {
    failWrites(db, ['email_inbox_messages'])
    getCurrentUser.mockResolvedValue(SIGNED_COACH)
    await post(T_STUDIO.id, { text: 'We open at 6.' })

    const [dead] = insertsInto(db, 'webhook_dead_letter')
    expect(dead.payload).toMatchObject({
      // NOT 'postmark' or 'inbody' — a REPLAYABLE_PROVIDERS key here would
      // have the replay cron "retry" a send that already happened, which IS
      // the double-send.
      provider: 'email_ticket_reply',
      event_type: 'sent_not_filed',
      // Stamped so integration health counts it (every other email writer
      // omits it and their dead letters go uncounted).
      location_id: T_STUDIO.location_id,
    })
    // The payload is everything a human (or a later re-file tool) needs to
    // reconstruct the missing message row — including the SIGNED body, which
    // at this point exists nowhere else server-side.
    expect(dead.payload.payload).toMatchObject({
      ticket_id: T_STUDIO.id,
      postmark_message_id: 'pm-out-1',
      text_body: 'We open at 6.\n\n-- \nSarah\nUN1T Stillorgan',
    })
    expect(dead.payload.payload.recipients.to).toEqual([T_STUDIO.requester_email])
  })

  it('still logs email_sends and advances the ticket — the queue must not invite a second send', async () => {
    failWrites(db, ['email_inbox_messages'])
    await post(T_STUDIO.id, { text: 'We open at 6.' })

    // The contact's history + delivery-webhook correlation survive: both key
    // on postmark_message_id, which the failed insert never carried.
    const [send] = insertsInto(db, 'email_sends')
    expect(send.payload).toMatchObject({
      contact_id: T_STUDIO.contact_id,
      postmark_message_id: 'pm-out-1',
      source_type: 'inbox_reply',
    })
    // And the queue stops saying "needs reply" about a member who has one —
    // same posture as compose, whose ticket row STAYS for exactly this reason.
    const [update] = updatesTo(db, 'email_tickets')
    expect(update.payload).toMatchObject({
      status: 'pending',
      last_message_direction: 'outbound',
      last_message_preview: expect.stringContaining('We open at 6.'),
    })
  })

  it('keeps the distinct answer when every breadcrumb ALSO fails', async () => {
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {})
    failWrites(db, ['email_inbox_messages', 'email_sends', 'email_tickets', 'webhook_dead_letter'])
    const res = await post(T_STUDIO.id, { text: 'We open at 6.' })

    // A DB bad enough to fail four writes must still not turn "already sent"
    // back into a retryable-looking error.
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toMatch(/do not resend/i)
    expect(body.data).toMatchObject({ sent: true })
    warns.mockRestore()
  })

  it('a NOTE whose insert fails stays a plain 500 — nothing was sent, so retrying is safe', async () => {
    failWrites(db, ['email_inbox_messages'])
    const res = await post(T_STUDIO.id, { text: 'fyi', internal: true })

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).not.toMatch(/do not resend/i)
    expect(body.data).toBeUndefined()
    expect(sendEmail).not.toHaveBeenCalled()
    expect(insertsInto(db, 'webhook_dead_letter')).toHaveLength(0)
  })
})

// ── MAILFIX-GUARDRAILS.1 — bookkeeping AFTER the send is LOGGED, never failed on ──
//
// Every write below the send is about a reply the member already has. Four of
// them were bare awaits — the email_sends log and the ticket patch, on BOTH
// the success path and the unfiled-send breadcrumb path — and a supabase
// builder RESOLVES with { error }, so a blip reported nothing: the member had
// the reply and the thread kept saying needs-reply with no line to explain the
// stuck flag. The fix is log-and-continue ONLY. These pin both halves: the
// response is exactly the one the send earned, AND a structural logError line
// names the ticket. A route that started failing the response on one of these
// writes fails the first assertion — that is the point (CLAUDE.md: removing a
// silent failure must never create a louder one).
describe('POST …/reply — a lost bookkeeping write after the send is LOGGED, never surfaced (MAILFIX-GUARDRAILS.1)', () => {
  let errors
  beforeEach(() => {
    errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => errors.mockRestore())

  it('email_sends insert fails on the SUCCESS path → 200 unchanged, one structural log line', async () => {
    failWrites(db, ['email_sends'])
    const res = await post(T_STUDIO.id, { text: 'We open at 6.' })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data).toMatchObject({ status: 'pending', message_id: 'pm-out-1' })
    // The message row and the queue advance still landed; only the log row is gone.
    expect(insertsInto(db, 'email_inbox_messages')).toHaveLength(1)
    expect(updatesTo(db, 'email_tickets')).toHaveLength(1)
    expect(insertsInto(db, 'email_sends')).toHaveLength(0)
    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith(
      'tickets/reply',
      'email_sends log failed (mail already sent)',
      expect.objectContaining({ ticketId: T_STUDIO.id, messageId: 'pm-out-1', error: expect.objectContaining({ code: 'XX000' }) }),
    )
  })

  it('ticket patch fails on the SUCCESS path → 200 unchanged, one structural log line naming the ticket', async () => {
    failWrites(db, ['email_tickets'])
    const res = await post(T_STUDIO.id, { text: 'We open at 6.' })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data).toMatchObject({ status: 'pending', message_id: 'pm-out-1' })
    expect(insertsInto(db, 'email_inbox_messages')).toHaveLength(1)
    expect(insertsInto(db, 'email_sends')).toHaveLength(1)
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith(
      'tickets/reply',
      expect.stringMatching(/^ticket patch failed after a successful send/),
      expect.objectContaining({ ticketId: T_STUDIO.id, messageId: 'pm-out-1', error: expect.objectContaining({ code: 'XX000' }) }),
    )
  })

  it('ticket patch matches NO row (the ticket vanished between read and write) → 200 unchanged, logged as zero rows', async () => {
    // PostgREST reports NO error for a zero-row UPDATE, so `{ error }` alone
    // would miss this. The ticket exists for the read at the top of the route;
    // a concurrent delete removes it just before the patch.
    const realFrom = db.from
    db.from = (table) => {
      const b = realFrom(table)
      if (table !== 'email_tickets') return b
      const origUpdate = b.update
      b.update = (payload) => {
        const rows = db._state.tickets
        const i = rows.findIndex(t => t.id === T_STUDIO.id)
        if (i >= 0) rows.splice(i, 1)
        return origUpdate(payload)
      }
      return b
    }
    const res = await post(T_STUDIO.id, { text: 'We open at 6.' })

    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith(
      'tickets/reply',
      'ticket patch matched no row after a successful send',
      expect.objectContaining({ ticketId: T_STUDIO.id, rows: 0 }),
    )
  })

  it('both breadcrumbs fail after an UNFILED send → the "do not resend" 500 is unchanged, both are logged', async () => {
    failWrites(db, ['email_inbox_messages', 'email_sends', 'email_tickets'])
    const res = await post(T_STUDIO.id, { text: 'We open at 6.' })

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toMatch(/do not resend/i)
    expect(body.data).toMatchObject({ sent: true, message_id: 'pm-out-1' })
    // The dead letter still landed first — the breadcrumb ORDER is unchanged.
    expect(insertsInto(db, 'webhook_dead_letter')).toHaveLength(1)
    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledTimes(2)
    expect(logError).toHaveBeenCalledWith(
      'tickets/reply',
      'email_sends log failed after an unfiled send (mail already sent)',
      expect.objectContaining({ ticketId: T_STUDIO.id, messageId: 'pm-out-1' }),
    )
    expect(logError).toHaveBeenCalledWith(
      'tickets/reply',
      'ticket patch failed after an unfiled send (mail already sent)',
      expect.objectContaining({ ticketId: T_STUDIO.id, messageId: 'pm-out-1' }),
    )
  })

  it('logs NOTHING when every write lands', async () => {
    const res = await post(T_STUDIO.id, { text: 'We open at 6.' })
    expect(res.status).toBe(200)
    expect(logError).not.toHaveBeenCalled()
  })
})

// EMAIL-MERGE.6 — nothing leaves a tombstone.
//
// THE ROUTE IS THE GATE. TicketThread hides the composer on a merged ticket,
// but this route runs on the service-role client, so RLS does nothing and the
// client-side guard protects only the client. The callers that matter are the
// ones that never had it: a stale tab, a bookmarked deep link, a push
// notification opened after somebody else merged — and THE MOBILE APP, which
// has no concept of merge at all, polls, and ships a reply button.
//
// What it prevents is the failure this whole feature exists to remove: the
// reply reaches the member, and is then filed on a ticket scopeToUnmerged hides
// from every queue and count — so nobody sees it was answered and the next
// person answers again. A duplicate reply, produced by the duplicate-reply fix.
describe('a merged ticket cannot be replied from', () => {
  const MERGED = { ...T_STUDIO, merged_into_id: T_ACCOUNTS.id, status: 'closed' }

  function setupMerged() {
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      tickets: [MERGED, { ...T_ACCOUNTS }],
      messages: [LAST_INBOUND],
    }))
  }

  it('refuses with 409 and names the survivor — and SENDS NOTHING', async () => {
    setupMerged()

    const res = await post(T_STUDIO.id, { text: 'Sorry for the delay.' })

    // 409, not the 404 every other refusal here returns: the caller has
    // already passed loadTicketForUser, so they can see this ticket and are
    // owed a reason. The request conflicts with what the ticket has become.
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toMatch(/merged into another one/i)
    // The survivor's id rides on the failure body so a client can route there
    // rather than dead-ending on a ticket it cannot send from.
    expect(body.data.merged_into_id).toBe(T_ACCOUNTS.id)

    // THE HALF THAT MATTERS. A refusal that still put the mail on the wire
    // would be the exact bug, with a red banner on top of it — the member gets
    // the answer twice and the second copy is filed where nobody looks.
    expect(sendEmail).not.toHaveBeenCalled()
    // …and nothing was written either. This route sends before it writes, so
    // refusing at the gate can leave no half-done state behind.
    expect(writesTo(db)).toEqual([])
  })

  it('refuses an internal note on a tombstone too', async () => {
    setupMerged()

    const res = await post(T_STUDIO.id, { text: 'Rang the council back.', internal: true })

    // A note puts no mail on the wire, so it is not the dangerous case — but it
    // would be written onto a ticket hidden from every queue and count, which
    // is an operator typing up what they found and losing it silently.
    expect(res.status).toBe(409)
    expect(insertsInto(db, 'email_inbox_messages')).toEqual([])
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('still replies normally on an ordinary ticket', async () => {
    // The negative half: a guard that refused everything would pass both tests
    // above while breaking the queue.
    setupDb(baseState({ grants: [GRANT_STUDIO], messages: [LAST_INBOUND] }))

    const res = await post(T_STUDIO.id, { text: 'We open at 6.' })

    expect(res.status).toBe(200)
    expect(sendEmail).toHaveBeenCalledTimes(1)
  })
})

// MAIL-SIG.1 — the reply route (the highest-traffic send path) carries the
// rich signature exactly as compose does; audit #3 flagged it untested.
it('a rich signature rides the reply in both parts; disabled keeps plain byte-for-byte', async () => {
  getCurrentUser.mockResolvedValue({
    ...COACH,
    email_signature: 'plain fallback',
    email_signature_rich: { enabled: true, name: 'Alex Example', title: 'Head Coach' },
  })
  setupDb(baseState({
    grants: [GRANT_STUDIO],
    tickets: [{ ...T_STUDIO }],
    messages: [{ id: 'm-in', ticket_id: T_STUDIO.id, location_id: T_STUDIO.location_id, direction: 'inbound', from_email: T_STUDIO.requester_email, text_body: 'hi', created_at: '2026-08-06T09:00:00Z' }],
  }))
  const res = await post(T_STUDIO.id, { text: 'Reply body' })
  expect(res.status).toBe(200)
  const sent = sendEmail.mock.calls[0][0]
  expect(sent.textBody).toContain('-- \nAlex Example')
  expect(sent.textBody).not.toContain('plain fallback')
  expect(sent.htmlBody).toContain('ALEX EXAMPLE'.length ? 'Alex Example' : '')
  expect(sent.htmlBody).toContain('border-top:3px solid #0f172a')
})

// ── MAIL-SIGDEFAULT.1 — the studio signature is on for everyone ─────────
// The send resolves through the SAME function the /account preview and the
// composers' hint run (resolveSendSignature), so these pin the send half of
// "what you see is what sends" for a person who never opted in.
describe('POST …/reply — the studio block goes out for everyone (MAIL-SIGDEFAULT.1)', () => {
  const HATCH_CARD = {
    phone: '(01) 574 1871',
    links: [{ label: 'Book a class', url: 'https://un1tdublin.com/welcome/hatch-street#start' }],
  }
  const withCard = (extra = {}) => baseState({
    grants: [GRANT_STUDIO],
    tickets: [{ ...T_STUDIO }],
    messages: [{ id: 'm-in', ticket_id: T_STUDIO.id, location_id: T_STUDIO.location_id, direction: 'inbound', from_email: T_STUDIO.requester_email, text_body: 'hi', created_at: '2026-08-06T09:00:00Z' }],
    locations: [{ id: T_STUDIO.location_id, name: 'UN1T Hatch Street' }],
    companySettings: [{ location_id: T_STUDIO.location_id, email_signature: HATCH_CARD }],
    ...extra,
  })

  it('a NEW HIRE (rich NULL, plain NULL) signs with the studio block in BOTH parts', async () => {
    getCurrentUser.mockResolvedValue({ ...COACH, email_signature: null, email_signature_rich: null })
    setupDb(withCard())
    const res = await post(T_STUDIO.id, { text: 'Reply body' })
    expect(res.status).toBe(200)
    const sent = sendEmail.mock.calls[0][0]
    expect(sent.textBody).toBe(
      'Reply body\n\n-- \nUN1T Hatch Street\n(01) 574 1871\nBook a class: https://un1tdublin.com/welcome/hatch-street#start'
    )
    expect(sent.htmlBody).toContain('border-top:3px solid #0f172a')
    expect(sent.htmlBody).toContain('(01) 574 1871')
    expect(sent.htmlBody).toContain('href="https://un1tdublin.com/welcome/hatch-street#start"')
  })

  it('personal rich DISABLED + a plain sign-off: the plain text rides ABOVE the studio block, nothing lost', async () => {
    getCurrentUser.mockResolvedValue({
      ...COACH,
      email_signature: 'Sarah\nHead Coach',
      email_signature_rich: { enabled: false, name: 'Nope' },
    })
    setupDb(withCard())
    await post(T_STUDIO.id, { text: 'Reply body' })
    const sent = sendEmail.mock.calls[0][0]
    expect(sent.textBody).toBe(
      'Reply body\n\n-- \nSarah\nHead Coach\n\nUN1T Hatch Street\n(01) 574 1871\nBook a class: https://un1tdublin.com/welcome/hatch-street#start'
    )
    expect(sent.htmlBody).toContain('Sarah')
    expect(sent.htmlBody.indexOf('Sarah')).toBeLessThan(sent.htmlBody.indexOf('border-top:3px solid #0f172a'))
    expect(sent.htmlBody).not.toContain('Nope')
  })

  it('a studio with NO card keeps the old behaviour byte-for-byte — nothing personal, nothing appended', async () => {
    getCurrentUser.mockResolvedValue({ ...COACH, email_signature: null, email_signature_rich: null })
    setupDb(withCard({ companySettings: [] }))
    await post(T_STUDIO.id, { text: 'Reply body' })
    const sent = sendEmail.mock.calls[0][0]
    expect(sent.textBody).toBe('Reply body')
    expect(sent.textBody).not.toContain('-- ')
    expect(sent.htmlBody).not.toContain('border-top:3px solid #0f172a')
  })

  it('an OPTED-IN person is unchanged: the merged personal block, the plain column left out', async () => {
    getCurrentUser.mockResolvedValue({
      ...COACH,
      email_signature: 'plain fallback',
      email_signature_rich: { enabled: true, name: 'Alex Example', title: 'Head Coach', phone: '087 1', links: [] },
    })
    setupDb(withCard())
    await post(T_STUDIO.id, { text: 'Reply body' })
    const sent = sendEmail.mock.calls[0][0]
    expect(sent.textBody).toBe(
      'Reply body\n\n-- \nAlex Example\nHead Coach · UN1T Hatch Street\n(01) 574 1871\nBook a class: https://un1tdublin.com/welcome/hatch-street#start'
    )
    expect(sent.textBody).not.toContain('plain fallback')
    expect(sent.htmlBody).toContain('Alex Example')
  })
})
