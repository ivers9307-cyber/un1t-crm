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
import { makeDb, insertsInto, updatesTo, writesTo, selectsFrom } from '../../_test-db'
import {
  MB_STUDIO, T_STUDIO, T_ACCOUNTS, T_OTHER_LOCATION,
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
  process.env.POSTMARK_FROM_EMAIL = 'UN1T <hello@un1t.ie>'
  getCurrentUser.mockResolvedValue(COACH)
  sendEmail.mockResolvedValue({ messageId: 'pm-out-1' })
  setupDb(baseState({ grants: [GRANT_STUDIO], messages: [LAST_INBOUND] }))
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

  // Mail clients follow the latest message; someone a member deliberately
  // dropped from a later reply stays dropped. Resurrecting them would re-copy
  // a person the member chose to exclude, over their head.
  it('follows the LATEST message — a participant dropped later is not resurrected', async () => {
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      messages: [
        { ...CC_INBOUND, id: 'm-old', created_at: '2026-08-06T09:00:00Z' },
        {
          ...CC_INBOUND, id: 'm-new', created_at: '2026-08-06T12:00:00Z',
          cc_emails: ['colleague@example.com'],
        },
      ],
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
  // threadParticipants() that started reading the column would find it absent
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
