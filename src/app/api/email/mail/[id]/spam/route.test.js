// MAIL-SPAM.1 — the two verbs on a quarantined conversation.
//
// "Not spam" RELEASES: the flag clears, the conversation is back in the
// inbox, and the notifications the webhook deliberately skipped at ingest
// fire now — the staff push (maybeNotifyInboundEmail, with the ticket's own
// facts) and the unread mirror (email_tickets.unread_count set to the number
// of unseen inbound messages, the same derivation the seen route uses).
//
// "Mark as spam" is the reverse, minus notifications: nobody is pinged about
// mail an operator has just said is junk.
//
// Both are IDEMPOTENT by the update's own transition filter: releasing an
// already-released conversation writes nothing and pings nobody, so a double
// click (or two operators) cannot double-notify.
//
// The gate is loadTicketForUser's, unchanged — every refusal is a 404.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/permissions', async () => {
  const actual = await vi.importActual('@/lib/permissions')
  return { ...actual, hasPermissionForLocation: vi.fn(() => true) }
})
vi.mock('@/lib/email-inbound-push', () => ({ maybeNotifyInboundEmail: vi.fn(async () => {}) }))

import { POST } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { maybeNotifyInboundEmail } from '@/lib/email-inbound-push'
import { makeDb, updatesTo, writesTo } from '../../../tickets/_test-db'
import {
  LOC_A, MB_MAIL, MB_TICKETS, T_STUDIO, T_ACCOUNTS, COACH, OWNER, GRANT_STUDIO, mailState, message,
} from '../../_test-fixtures'

const QUARANTINED = {
  ...T_STUDIO,
  is_spam: true,
  spam_score: 7.2,
  spam_flagged_at: '2026-08-06T09:00:00Z',
  spam_verdict_source: 'ingest',
  unread_count: 0,
  status: 'open',
  last_message_direction: 'inbound',
}

function post(body) {
  return new Request('http://x/api/email/mail/x/spam', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function spam(id, body) {
  const res = await POST(post(body), { params: Promise.resolve({ id }) })
  return { res, body: await res.json() }
}

let db
function setupDb(state) {
  db = makeDb(state)
  createServerClient.mockImplementation(() => db)
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
  hasPermissionForLocation.mockReturnValue(true)
  getCurrentUser.mockResolvedValue(OWNER)
  setupDb(mailState({
    tickets: [{ ...QUARANTINED }, { ...T_ACCOUNTS }],
    messages: [
      message({ ticket_id: T_STUDIO.id, seen_at: null }),
      message({ ticket_id: T_STUDIO.id, seen_at: null }),
      // A read one, and our own reply — neither counts as unread.
      message({ ticket_id: T_STUDIO.id, seen_at: '2026-08-06T10:00:00Z' }),
      message({ ticket_id: T_STUDIO.id, direction: 'outbound', seen_at: null }),
    ],
  }))
})

describe('gates', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await spam(T_STUDIO.id, { spam: false })).res.status).toBe(401)
    expect(writesTo(db)).toEqual([])
  })

  it('400s a body that is not { spam: boolean }', async () => {
    expect((await spam(T_STUDIO.id, { spam: 'yes' })).res.status).toBe(400)
    expect((await spam(T_STUDIO.id, {})).res.status).toBe(400)
    expect(writesTo(db)).toEqual([])
  })

  it('404s (never 403) a coach acting on a mailbox they are not granted', async () => {
    getCurrentUser.mockResolvedValue(COACH)
    setupDb(mailState({ tickets: [{ ...T_ACCOUNTS }], grants: [GRANT_STUDIO] }))
    expect((await spam(T_ACCOUNTS.id, { spam: true })).res.status).toBe(404)
    expect(writesTo(db)).toEqual([])
  })

  it('404s an unknown id', async () => {
    expect((await spam('00000000-0000-4000-8000-000000000000', { spam: true })).res.status).toBe(404)
  })
})

describe('not spam — release', () => {
  it('clears the flag, keeps the score for audit, and answers with a list-shaped row back in the inbox', async () => {
    const { res, body } = await spam(T_STUDIO.id, { spam: false })
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    const c = body.data.conversation
    expect(c.id).toBe(T_STUDIO.id)
    expect(c.is_spam).toBe(false)
    expect(c.spam_score).toBe(7.2)
    expect(c.spam_verdict_source).toBe('operator')
    expect(c.spam_flagged_at).toBeNull()
    // Open with an inbound last message → it is now waiting on us.
    expect(c.needs_reply).toBe(true)
    expect(c.archived).toBe(false)
    expect(body.data.notified).toBe(true)
  })

  it('fires the staff push the webhook skipped at ingest, with the ticket’s own facts', async () => {
    await spam(T_STUDIO.id, { spam: false })
    expect(maybeNotifyInboundEmail).toHaveBeenCalledTimes(1)
    const [, args] = maybeNotifyInboundEmail.mock.calls[0]
    expect(args).toMatchObject({
      locationId: LOC_A,
      ticketId: T_STUDIO.id,
      ticketMailboxId: MB_MAIL.id,
      fromEmail: 'member@example.com',
      requesterName: 'Ada Member',
      subject: 'Class times',
      preview: 'What time is the 6am?',
      // The ping gate: 0 means "this is the message that makes it unseen".
      preUnreadCount: 0,
      assignedTo: null,
    })
    // Own addresses are every mailbox at the studio — the same suppression
    // the webhook applies, so a released echo of our own mail pings nobody.
    expect(args.ownAddresses).toEqual(expect.arrayContaining([MB_MAIL.address, MB_TICKETS.address]))
  })

  it('mirrors unread_count from the unseen inbound messages — the seen route’s own derivation', async () => {
    await spam(T_STUDIO.id, { spam: false })
    const mirror = updatesTo(db, 'email_tickets').find(u => 'unread_count' in u.payload)
    expect(mirror).toBeTruthy()
    expect(mirror.payload.unread_count).toBe(2)
  })

  it('is idempotent: releasing an already-live conversation writes nothing and pings nobody', async () => {
    await spam(T_STUDIO.id, { spam: false })
    vi.mocked(maybeNotifyInboundEmail).mockClear()
    const before = writesTo(db).length
    const { res, body } = await spam(T_STUDIO.id, { spam: false })
    expect(res.status).toBe(200)
    expect(body.data.notified).toBe(false)
    expect(body.data.conversation.is_spam).toBe(false)
    expect(maybeNotifyInboundEmail).not.toHaveBeenCalled()
    expect(writesTo(db).length).toBe(before)
  })

  it('the UPDATE carries the transition filter, so two operators racing cannot both notify', async () => {
    await spam(T_STUDIO.id, { spam: false })
    const flip = updatesTo(db, 'email_tickets').find(u => 'is_spam' in u.payload)
    expect(flip).toBeTruthy()
    // PostgREST returns the rows it changed; with this filter the loser of a
    // race changes zero rows and the route reports notified: false.
    expect(flip.filters).toContainEqual(['eq', 'is_spam', true])
    expect(flip.filters).toContainEqual(['eq', 'id', T_STUDIO.id])
  })

  it('a push failure never fails the release', async () => {
    vi.mocked(maybeNotifyInboundEmail).mockRejectedValueOnce(new Error('apns down'))
    const { res, body } = await spam(T_STUDIO.id, { spam: false })
    expect(res.status).toBe(200)
    expect(body.data.conversation.is_spam).toBe(false)
  })
})

describe('mark as spam', () => {
  it('sets the flag with an operator verdict and a fresh flagged_at, and pings nobody', async () => {
    setupDb(mailState({ tickets: [{ ...T_STUDIO, status: 'open', last_message_direction: 'inbound' }] }))
    const { res, body } = await spam(T_STUDIO.id, { spam: true })
    expect(res.status).toBe(200)
    const c = body.data.conversation
    expect(c.is_spam).toBe(true)
    expect(c.spam_verdict_source).toBe('operator')
    expect(typeof c.spam_flagged_at).toBe('string')
    // Quarantined rows are never needs-reply, whatever their status says.
    expect(c.needs_reply).toBe(false)
    expect(body.data.notified).toBe(false)
    expect(maybeNotifyInboundEmail).not.toHaveBeenCalled()
  })

  it('does not touch the score a previous verdict recorded', async () => {
    setupDb(mailState({ tickets: [{ ...T_STUDIO, spam_score: 2.1 }] }))
    const { body } = await spam(T_STUDIO.id, { spam: true })
    expect(body.data.conversation.spam_score).toBe(2.1)
  })

  it('the UPDATE carries the transition filter (live → spam)', async () => {
    setupDb(mailState({ tickets: [{ ...T_STUDIO }] }))
    await spam(T_STUDIO.id, { spam: true })
    const flip = updatesTo(db, 'email_tickets').find(u => 'is_spam' in u.payload)
    expect(flip.filters).toContainEqual(['eq', 'is_spam', false])
  })

  it('is idempotent on an already-quarantined conversation', async () => {
    const before = writesTo(db).length
    const { res, body } = await spam(T_STUDIO.id, { spam: true })
    expect(res.status).toBe(200)
    expect(body.data.conversation.is_spam).toBe(true)
    expect(writesTo(db).length).toBe(before)
  })
})
