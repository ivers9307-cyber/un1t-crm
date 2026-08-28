// MAIL-TRIAL.B — the Mail surface's two verbs: archive, and read state.
//
// THE PROPERTY THIS FILE EXISTS FOR
// 🔴 A MAIL-SURFACE VERB MUST NOT REACH A TICKETING MAILBOX. Both routes take
// an id from the caller, and every id in the system is the same shape, so the
// only thing standing between "archive my mail" and "archive somebody else's
// ticket" is assertInboxSurface. It is the mirror of the guard on the IMAP
// write helper, and the fixture world is built so that dropping it fails here:
// accounts@ sits at the SAME location, the caller is an owner, and its ticket
// is one POST away.
//
// The second property is smaller and just as easy to lose: this surface must be
// structurally incapable of writing the lifecycle values it claims to have
// dropped. `solved` and `pending` are not options the schema can express.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
// Phase A's module, stubbed rather than run: it opens real IMAP connections.
// Stubbing it is also what lets these tests assert the PAIRING — that the CRM
// write and the mailbox write happen together, which is the property the
// poller's bidirectional sync makes load-bearing.
vi.mock('@/lib/mail/imap-writeback', () => ({
  markSeen: vi.fn(async () => ({ ok: true, applied: true, uid: 1 })),
  markUnseen: vi.fn(async () => ({ ok: true, applied: true, uid: 1 })),
  archiveMessage: vi.fn(async () => ({ ok: true, applied: true, uid: 1, folder: 'Archive', via: 'special-use' })),
}))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/permissions', async () => {
  const actual = await vi.importActual('@/lib/permissions')
  return { ...actual, hasPermissionForLocation: vi.fn(() => true) }
})

import { POST as ARCHIVE } from './archive/route'
import { POST as SEEN } from './seen/route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { markSeen, markUnseen, archiveMessage } from '@/lib/mail/imap-writeback'
import { applyWriteback, writebackNotice } from '../_writeback'
import { makeDb, updatesTo, writesTo } from '../../tickets/_test-db'
import {
  T_STUDIO, T_ACCOUNTS, COACH, OWNER, GRANT_STUDIO, mailState, message,
} from '../_test-fixtures'

function post(body) {
  return new Request('http://x/api/email/mail/x', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function archive(id, body) {
  const res = await ARCHIVE(post(body), { params: Promise.resolve({ id }) })
  return { res, body: await res.json() }
}

async function seen(id, body) {
  const res = await SEEN(post(body), { params: Promise.resolve({ id }) })
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
  markSeen.mockResolvedValue({ ok: true, applied: true, uid: 1 })
  markUnseen.mockResolvedValue({ ok: true, applied: true, uid: 1 })
  archiveMessage.mockResolvedValue({ ok: true, applied: true, uid: 1, folder: 'Archive', via: 'special-use' })
  hasPermissionForLocation.mockReturnValue(true)
  getCurrentUser.mockResolvedValue(OWNER)
  setupDb(mailState())
})

describe('POST /api/email/mail/[id]/archive', () => {
  it('401s when unauthenticated, and writes nothing', async () => {
    getCurrentUser.mockResolvedValue(null)
    const { res } = await archive(T_STUDIO.id, { archived: true })
    expect(res.status).toBe(401)
    expect(writesTo(db)).toEqual([])
  })

  it('400s on a body that is not a boolean archived flag', async () => {
    expect((await archive(T_STUDIO.id, { status: 'closed' })).res.status).toBe(400)
    expect((await archive(T_STUDIO.id, { archived: 'yes' })).res.status).toBe(400)
    expect(writesTo(db)).toEqual([])
  })

  // 🔴 The surface guard.
  it('404s — and writes nothing — for a conversation on a surface=tickets mailbox', async () => {
    const { res, body } = await archive(T_ACCOUNTS.id, { archived: true })
    expect(res.status).toBe(404)
    // 404, never 403: the caller must not learn that the id exists on the
    // other screen.
    expect(body.error).toBe('Not found')
    expect(writesTo(db)).toEqual([])
  })

  it('404s for a conversation with no mailbox at all', async () => {
    setupDb(mailState({ tickets: [{ ...T_STUDIO, mailbox_id: null }] }))
    expect((await archive(T_STUDIO.id, { archived: true })).res.status).toBe(404)
    expect(writesTo(db)).toEqual([])
  })

  it('refuses LOUDLY rather than writing when the surface check itself fails', async () => {
    setupDb(mailState({ errors: { email_mailboxes: { code: '42703', message: 'boom' } } }))
    const { res } = await archive(T_STUDIO.id, { archived: true })
    // The access gate fails first here, and either way nothing is written on a
    // check that could not answer — "we could not tell" is never "yes".
    expect(res.status).toBe(500)
    expect(writesTo(db)).toEqual([])
  })

  it('archives by writing status=closed and stamping closed_at', async () => {
    const { res, body } = await archive(T_STUDIO.id, { archived: true })
    expect(res.status).toBe(200)
    const [write] = updatesTo(db, 'email_tickets')
    expect(write.payload.status).toBe('closed')
    expect(write.payload.closed_at).toBeTruthy()
    // The response carries this surface's derived flags, so the client never
    // re-derives what it was already told.
    expect(body.data.conversation.archived).toBe(true)
    expect(body.data.conversation.needs_reply).toBe(false)
  })

  // 🔴 The pairing. `status='closed'` alone leaves the message sitting in the
  // operator's real mailbox, which is the second triage this surface exists to
  // remove.
  it('also moves the message to Archive in the mailbox itself', async () => {
    setupDb(mailState({
      tickets: [{ ...T_STUDIO }],
      messages: [message({ id: 'm1', rfc_message_id: '<a@mail>' })],
    }))
    await archive(T_STUDIO.id, { archived: true })
    expect(archiveMessage).toHaveBeenCalledTimes(1)
    expect(archiveMessage.mock.calls[0][1]).toBe(T_STUDIO.mailbox_id)
    // The rfcMessageId seam: nothing writes an IMAP UID onto our message rows.
    expect(archiveMessage.mock.calls[0][2]).toEqual({ rfcMessageId: '<a@mail>' })
  })

  it('never moves an OUTBOUND message — it lives in Sent, not INBOX', async () => {
    setupDb(mailState({
      tickets: [{ ...T_STUDIO }],
      messages: [
        message({ id: 'm1', rfc_message_id: '<in@mail>' }),
        message({ id: 'm2', direction: 'outbound', rfc_message_id: '<out@mail>' }),
      ],
    }))
    await archive(T_STUDIO.id, { archived: true })
    expect(archiveMessage).toHaveBeenCalledTimes(1)
    expect(archiveMessage.mock.calls[0][2]).toEqual({ rfcMessageId: '<in@mail>' })
  })

  it('does NOT touch the mailbox when bringing a conversation back', async () => {
    // There is no move-out-of-Archive in the write-back module, and inventing
    // one here would be a third operation on somebody's mailbox.
    setupDb(mailState({
      tickets: [{ ...T_STUDIO, status: 'closed' }],
      messages: [message({ id: 'm1', rfc_message_id: '<a@mail>' })],
    }))
    await archive(T_STUDIO.id, { archived: false })
    expect(archiveMessage).not.toHaveBeenCalled()
  })

  it('records the archive and REPORTS the mailbox half when it fails', async () => {
    // Rolling the row back would cost the operator the action they just took in
    // order to tell them half of it did not happen.
    archiveMessage.mockResolvedValue({
      ok: false, reason: 'auth_failed', error: 'The mail server refused this login.',
    })
    setupDb(mailState({
      tickets: [{ ...T_STUDIO }],
      messages: [message({ id: 'm1', rfc_message_id: '<a@mail>' })],
    }))
    const { res, body } = await archive(T_STUDIO.id, { archived: true })
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(db._state.tickets[0].status).toBe('closed')
    expect(body.data.writeback_notice).toBe('The mail server refused this login.')
  })

  it('treats "not in the mailbox any more" as done, not as a failure', async () => {
    // Already archived there by hand is the most ordinary outcome there is.
    archiveMessage.mockResolvedValue({ ok: false, reason: 'not_in_mailbox', error: 'gone' })
    setupDb(mailState({
      tickets: [{ ...T_STUDIO }],
      messages: [message({ id: 'm1', rfc_message_id: '<a@mail>' })],
    }))
    const { body } = await archive(T_STUDIO.id, { archived: true })
    expect(body.data.writeback_notice).toBeNull()
  })

  it('never opens two mailbox connections at once', async () => {
    // Gmail caps SIMULTANEOUS connections per account, and exceeding it locks
    // the operator out of their own mailbox. The loop is sequential, and this
    // is what proves it.
    let open = 0
    let peak = 0
    archiveMessage.mockImplementation(async () => {
      open += 1
      peak = Math.max(peak, open)
      await Promise.resolve()
      open -= 1
      return { ok: true, applied: true, uid: 1 }
    })
    setupDb(mailState({
      tickets: [{ ...T_STUDIO }],
      messages: [
        message({ id: 'm1', rfc_message_id: '<1@mail>' }),
        message({ id: 'm2', rfc_message_id: '<2@mail>' }),
        message({ id: 'm3', rfc_message_id: '<3@mail>' }),
      ],
    }))
    await archive(T_STUDIO.id, { archived: true })
    expect(archiveMessage).toHaveBeenCalledTimes(3)
    expect(peak).toBe(1)
  })

  it('caps how many messages one click may touch, and says when it did', async () => {
    setupDb(mailState({
      tickets: [{ ...T_STUDIO }],
      messages: Array.from({ length: 7 }, (_, i) =>
        message({ id: `m${i}`, rfc_message_id: `<${i}@mail>` })),
    }))
    const { body } = await archive(T_STUDIO.id, { archived: true })
    expect(archiveMessage).toHaveBeenCalledTimes(5)
    expect(body.data.writeback_notice).toMatch(/left in the mailbox/)
  })

  // 🔴 WHICH five, not just how many. The cap makes this query decide what stays
  // in the operator's real INBOX, so an unordered read left an arbitrary subset
  // — in practice the most RECENT messages, the ones at the top of head office's
  // Gmail and the worst to leave — while the notice claimed the oldest were left.
  it('archives the NEWEST messages and strands the oldest, matching what the notice says', async () => {
    const at = (day) => `2026-08-${String(day).padStart(2, '0')}T09:00:00Z`
    setupDb(mailState({
      tickets: [{ ...T_STUDIO }],
      // Deliberately inserted oldest-first, which is the order an unordered
      // query returns and therefore the order that used to be archived.
      messages: [1, 2, 3, 4, 5, 6, 7].map(d =>
        message({ id: `m${d}`, rfc_message_id: `<${d}@mail>`, created_at: at(d) })),
    }))

    const { body } = await archive(T_STUDIO.id, { archived: true })

    const moved = archiveMessage.mock.calls.map(c => c[2].rfcMessageId).sort()
    expect(moved).toEqual(['<3@mail>', '<4@mail>', '<5@mail>', '<6@mail>', '<7@mail>'])
    // The two left behind are the two OLDEST, which is what the sentence says.
    expect(moved).not.toContain('<1@mail>')
    expect(moved).not.toContain('<2@mail>')
    expect(body.data.writeback_notice).toMatch(/oldest ones were left in the mailbox/)
    // And it tells the operator the remainder is theirs to finish — nothing
    // converges archive state, so a second click cannot reach them.
    expect(body.data.writeback_notice).toMatch(/archive those in the mail app/i)
  })

  it('brings one back as `open`, not `pending`, and clears the stamps', async () => {
    // `open` is honest: whether it then reads as needing a reply is decided by
    // last_message_direction, which is a fact about the correspondence.
    // Restoring `pending` would silently claim we had already answered.
    setupDb(mailState({
      tickets: [{ ...T_STUDIO, status: 'closed', closed_at: '2026-08-06T12:00:00Z', last_message_direction: 'inbound' }],
    }))
    const { body } = await archive(T_STUDIO.id, { archived: false })
    const [write] = updatesTo(db, 'email_tickets')
    expect(write.payload.status).toBe('open')
    expect(write.payload.closed_at).toBeNull()
    expect(body.data.conversation.archived).toBe(false)
    expect(body.data.conversation.needs_reply).toBe(true)
  })

  it('cannot express the lifecycle values this surface dropped', async () => {
    // The schema takes a boolean, so there is no wire format for solved or
    // pending — "dropping the lifecycle" has to mean the surface is incapable
    // of it, not merely that no button renders.
    for (const attempt of [{ archived: 'solved' }, { archived: 1 }, { archived: null }]) {
      expect((await archive(T_STUDIO.id, attempt)).res.status).toBe(400)
    }
    expect(writesTo(db)).toEqual([])
  })

  it('still honours the per-account grant — a coach without one gets 404', async () => {
    getCurrentUser.mockResolvedValue(COACH)
    setupDb(mailState({ grants: [] }))
    expect((await archive(T_STUDIO.id, { archived: true })).res.status).toBe(404)
    expect(writesTo(db)).toEqual([])
  })

  it('…and works for the coach who does hold it', async () => {
    getCurrentUser.mockResolvedValue(COACH)
    setupDb(mailState({ grants: [GRANT_STUDIO] }))
    expect((await archive(T_STUDIO.id, { archived: true })).res.status).toBe(200)
  })
})

describe('POST /api/email/mail/[id]/seen', () => {
  const withMessages = (rows) => setupDb(mailState({ tickets: [{ ...T_STUDIO }], messages: rows }))

  it('404s — and writes nothing — for a conversation on the ticket surface', async () => {
    expect((await seen(T_ACCOUNTS.id, { seen: true })).res.status).toBe(404)
    expect(writesTo(db)).toEqual([])
  })

  it('stamps seen_at on the unread inbound messages only', async () => {
    withMessages([
      message({ id: 'm1', seen_at: null }),
      message({ id: 'm2', direction: 'outbound', seen_at: null }),
    ])
    const { res, body } = await seen(T_STUDIO.id, { seen: true })
    expect(res.status).toBe(200)
    expect(body.data.unread).toBe(0)

    const rows = db._state.messages
    expect(rows.find(m => m.id === 'm1').seen_at).toBeTruthy()
    // Our own reply is not something to read — stamping it would make "unread"
    // mean "recent".
    expect(rows.find(m => m.id === 'm2').seen_at).toBeNull()
  })

  // 🔴 The pairing, and the reason it is not optional: the poller converges
  // seen_at against the mailbox in BOTH directions, so a column written alone
  // is a read mark that undoes itself within about a quarter of an hour.
  it('also marks the message \\Seen in the mailbox itself', async () => {
    withMessages([message({ id: 'm1', seen_at: null, rfc_message_id: '<a@mail>' })])
    await seen(T_STUDIO.id, { seen: true })
    expect(markSeen).toHaveBeenCalledTimes(1)
    expect(markSeen.mock.calls[0][1]).toBe(T_STUDIO.mailbox_id)
    expect(markSeen.mock.calls[0][2]).toEqual({ rfcMessageId: '<a@mail>' })
  })

  it('only writes back the messages the CRM write actually changed', async () => {
    // The common case is one connection, because the set is "what was unread",
    // not "every message on the thread".
    withMessages([
      message({ id: 'm1', seen_at: '2026-08-06T09:30:00Z', rfc_message_id: '<old@mail>' }),
      message({ id: 'm2', seen_at: null, rfc_message_id: '<new@mail>' }),
    ])
    await seen(T_STUDIO.id, { seen: true })
    expect(markSeen).toHaveBeenCalledTimes(1)
    expect(markSeen.mock.calls[0][2]).toEqual({ rfcMessageId: '<new@mail>' })
  })

  it('records the read state and REPORTS a mailbox half that failed', async () => {
    markSeen.mockResolvedValue({ ok: false, reason: 'write_failed', error: 'Could not reach the mail server.' })
    withMessages([message({ id: 'm1', seen_at: null, rfc_message_id: '<a@mail>' })])
    const { res, body } = await seen(T_STUDIO.id, { seen: true })
    expect(res.status).toBe(200)
    expect(db._state.messages[0].seen_at).toBeTruthy()
    expect(body.data.writeback_notice).toBe('Could not reach the mail server.')
  })

  it('says so when a message cannot be matched back to the mailbox', async () => {
    // Nothing writes an IMAP UID onto our rows, so rfc_message_id is the only
    // seam — a row without one cannot be written back at all.
    withMessages([message({ id: 'm1', seen_at: null, rfc_message_id: null })])
    const { body } = await seen(T_STUDIO.id, { seen: true })
    expect(markSeen).not.toHaveBeenCalled()
    expect(body.data.writeback_notice).toMatch(/could not be matched back/)
  })

  it('is idempotent — re-opening a conversation does not rewrite when it was read', async () => {
    const alreadySeen = '2026-08-06T09:30:00Z'
    withMessages([message({ id: 'm1', seen_at: alreadySeen })])
    await seen(T_STUDIO.id, { seen: true })
    expect(db._state.messages[0].seen_at).toBe(alreadySeen)
  })

  // 🔴 MARK-UNREAD IS PAIRED, LIKE ITS TWIN. It was refused outright at first,
  // correctly, because there was no markUnseen() to pair with and the poller
  // converges a CRM-only unread mark away within about a quarter of an hour.
  // The remedy was the paired IMAP write, not a permanently missing verb: the
  // ticket queue has reopen, so a mail surface with no defer verb at all would
  // have biased the comparison the trial exists to settle.
  it('marks unread in BOTH halves — the column and the mailbox', async () => {
    withMessages([message({ id: 'm1', rfc_message_id: '<1@mail>', seen_at: '2026-08-06T09:30:00Z' })])

    const { res, body } = await seen(T_STUDIO.id, { seen: false })

    expect(res.status).toBe(200)
    expect(db._state.messages[0].seen_at).toBeNull()
    // The mailbox half really was asked for, over the row that changed.
    expect(markUnseen).toHaveBeenCalledTimes(1)
    expect(markUnseen.mock.calls[0][2]).toMatchObject({ rfcMessageId: '<1@mail>' })
    // And never the ADD direction.
    expect(markSeen).not.toHaveBeenCalled()
    expect(body.data.unread).toBe(1)
  })

  it('marking unread twice is a no-op — the guard runs in both directions', async () => {
    withMessages([message({ id: 'm1', rfc_message_id: '<1@mail>', seen_at: null })])

    await seen(T_STUDIO.id, { seen: false })

    // Nothing was unread-able, so nothing was written and no connection opened.
    expect(markUnseen).not.toHaveBeenCalled()
  })

  // 🔴 THE POSTMARK CASE. accounts@hatchstreetfitness.com has its domain MX
  // pointed at inbound.postmarkapp.com, so there is no mail server behind it —
  // the message was never stored anywhere the write-back could reach. That is a
  // permanent fact about the account, not a failure of this click, and counting
  // it as one put "there is no mailbox to change" under every read and every
  // archive on the one configuration where nothing could have gone wrong.
  //
  // Asserted on the ROUTE'S RESPONSE, not on applyWriteback's return value: the
  // whole defect was that a correct verdict object was rendered as an error.
  it('says NOTHING when the account has no mail server behind it', async () => {
    markSeen.mockResolvedValue({ ok: false, reason: 'not_imap', error: 'This account receives mail through Postmark rather than a connected login, so there is no mailbox to change.' })
    withMessages([
      message({ id: 'm1', rfc_message_id: '<1@mail>', seen_at: null }),
      message({ id: 'm2', rfc_message_id: '<2@mail>', seen_at: null }),
      message({ id: 'm3', rfc_message_id: '<3@mail>', seen_at: null }),
    ])

    const { res, body } = await seen(T_STUDIO.id, { seen: true })

    expect(res.status).toBe(200)
    expect(body.data.writeback_notice).toBeNull()
    // The CRM half still happened — the read state is the point of the click.
    expect(db._state.messages.every(m => m.seen_at !== null)).toBe(true)
    // And it asked ONCE, not once per message: the answer is a property of the
    // account, so re-reading the mailbox row three times to be told the same
    // thing is pure cost.
    expect(markSeen).toHaveBeenCalledTimes(1)
  })

  it('says nothing on archive either, for the same account', async () => {
    archiveMessage.mockResolvedValue({ ok: false, reason: 'not_imap', error: 'no mailbox' })
    withMessages([message({ id: 'm1', rfc_message_id: '<1@mail>' })])

    const { body } = await archive(T_STUDIO.id, { archived: true })

    expect(body.data.writeback_notice).toBeNull()
    expect(body.data.conversation.status).toBe('closed')
  })

  it('keeps email_tickets.unread_count in agreement with the rows it just wrote', async () => {
    // Two counters for one fact is how a badge ends up pointing at an empty
    // list. seen_at is the truth; the column follows it.
    withMessages([message({ id: 'm1', seen_at: null })])
    await seen(T_STUDIO.id, { seen: true })
    expect(db._state.tickets[0].unread_count).toBe(0)
  })

  it('400s on anything that is not the literal true', async () => {
    expect((await seen(T_STUDIO.id, { seen: 'true' })).res.status).toBe(400)
    expect((await seen(T_STUDIO.id, {})).res.status).toBe(400)
    expect(writesTo(db)).toEqual([])
  })

  it('500s when the seen_at write fails, rather than reporting a read it did not record', async () => {
    setupDb(mailState({
      tickets: [{ ...T_STUDIO }],
      errors: { email_inbox_messages: { code: '42703', message: 'column "seen_at" does not exist' } },
    }))
    const { res, body } = await seen(T_STUDIO.id, { seen: true })
    expect(res.status).toBe(500)
    expect(body.success).toBe(false)
  })
})


// The two halves of the Postmark fix, exercised directly. The route tests above
// prove the operator sees nothing; these prove WHY, so a future edit to either
// half fails here rather than silently restoring "there is no mailbox to
// change" under every click.
describe('applyWriteback / writebackNotice — an account with no mail server', () => {
  it('reports noMailbox and files NO failure', async () => {
    markSeen.mockResolvedValue({ ok: false, reason: 'not_imap', error: 'no mailbox' })

    const out = await applyWriteback({}, 'mb-1', ['<1@mail>', '<2@mail>'], 'seen')

    expect(out.noMailbox).toBe(true)
    expect(out.failures).toEqual([])
    // Asked once for two messages: the answer is a property of the account.
    expect(markSeen).toHaveBeenCalledTimes(1)
  })

  it('stays silent even if a result somehow carries both', () => {
    // Unreachable through applyWriteback (the skip breaks before any failure
    // can be pushed), and asserted anyway: "this account has no mailbox" is the
    // stronger fact, and it must win over whatever else is in the object.
    expect(writebackNotice(
      { noMailbox: true, failures: [{ reason: 'x', error: 'boom' }], skipped: 3, unreferenced: 2 },
      'seen',
    )).toBeNull()
  })
})
