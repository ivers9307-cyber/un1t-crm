// EMAIL-MERGE.4 — folding one ticket into another, and undoing it.
//
// The load-bearing assertions here are about DATA, not status codes. Merge
// moves another ticket's correspondence, so the tests assert on the rows the
// fake actually holds afterwards: which ticket each message belongs to, and
// which of them carry the merged_from_ticket_id stamp. A route that reparented
// nothing and only flipped the pointer would pass every response-shape check
// and quietly strand the conversation on a hidden ticket.
//
// hasPermission IS NOT MOCKED, deliberately. Six email route test files once
// stubbed it, so the location gate never ran and a real authorisation bug
// shipped (#1266). The permission resolves through the real resolver against
// the fixtures' assignmentsByLocation, exactly as the sibling tests now do.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})

import { POST, DELETE } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { makeDb, writesTo, updatesTo, failWrites, insertsInto } from '../../_test-db'
import {
  T_STUDIO, T_ACCOUNTS, COACH, OWNER, GRANT_STUDIO, baseState,
} from '../../_test-fixtures'

function post(id, body) {
  return POST(
    new Request(`http://x/api/email/tickets/${id}/merge`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  )
}

function del(id) {
  return DELETE(
    new Request(`http://x/api/email/tickets/${id}/merge`, { method: 'DELETE' }),
    { params: Promise.resolve({ id }) }
  )
}

// The source's own message, and one the TARGET already had. Test 5 needs both:
// "restores exactly the rows that moved" is only a claim if there is a row that
// must NOT move back.
const M_SOURCE = {
  id: 'm-src', ticket_id: T_ACCOUNTS.id, location_id: T_ACCOUNTS.location_id,
  direction: 'inbound', text_body: 'My DD bounced', is_internal_note: false,
  created_at: '2026-08-06T10:00:00Z',
}
const M_TARGET_NATIVE = {
  id: 'm-native', ticket_id: T_STUDIO.id, location_id: T_STUDIO.location_id,
  direction: 'inbound', text_body: 'What time is the 6am?', is_internal_note: false,
  created_at: '2026-08-06T09:00:00Z',
}

let db
/**
 * The fake applies updates IN PLACE, so every message must be a fresh copy —
 * baseState() already spreads its tickets for this reason and the messages come
 * in unspread. Sharing them let one merge leave `merged_from_ticket_id` set on
 * a module-level constant, which the next test then read as a ticket that had
 * absorbed a previous merge. Found by the absorbed-merge check itself.
 */
function setupDb(extra = {}) {
  const { messages = [M_TARGET_NATIVE, M_SOURCE], ...rest } = extra
  db = makeDb(baseState({ messages: messages.map(m => ({ ...m })), ...rest }))
  createServerClient.mockImplementation(() => db)
  return db
}

const ticketRow = (id) => db._state.tickets.find(t => t.id === id)
const messageRow = (id) => db._state.messages.find(m => m.id === id)

beforeEach(() => {
  vi.clearAllMocks()
  // Elevated at LOC_A, so BOTH mailboxes are visible and the merge is about
  // merging rather than about who can see what. The gate gets its own tests.
  getCurrentUser.mockResolvedValue(OWNER)
  setupDb()
})

describe('POST …/merge', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post(T_ACCOUNTS.id, { into: T_STUDIO.id })).status).toBe(401)
    expect(writesTo(db)).toEqual([])
  })

  it('400s on a body that names no target', async () => {
    expect((await post(T_ACCOUNTS.id, {})).status).toBe(400)
    expect((await post(T_ACCOUNTS.id, { into: 'not-a-uuid' })).status).toBe(400)
    expect(writesTo(db)).toEqual([])
  })

  // THE CORE. Reparenting is not cosmetic: the inbound webhook threads replies
  // on email_inbox_messages.ticket_id, so moving that column is what makes the
  // survivor the live thread. A merge that only flipped the pointer would send
  // the council's next reply back to the dead ticket.
  it('reparents the source messages and tombstones the source', async () => {
    const res = await post(T_ACCOUNTS.id, { into: T_STUDIO.id })
    expect(res.status).toBe(200)

    const moved = messageRow('m-src')
    expect(moved.ticket_id).toBe(T_STUDIO.id)
    // The stamp is what makes unmerge exact — see the unmerge block below.
    expect(moved.merged_from_ticket_id).toBe(T_ACCOUNTS.id)
    // The target's own message is untouched by the reparent.
    expect(messageRow('m-native').ticket_id).toBe(T_STUDIO.id)
    expect(messageRow('m-native').merged_from_ticket_id ?? null).toBeNull()

    const source = ticketRow(T_ACCOUNTS.id)
    expect(source.merged_into_id).toBe(T_STUDIO.id)
    expect(source.merged_at).toBeTruthy()
    expect(source.merged_by).toBe(OWNER.id)
    // A tombstone is `closed` PLUS a pointer — never a fifth status value.
    expect(source.status).toBe('closed')
    expect(source.closed_at).toBeTruthy()
    // Its unread_count is deliberately RETAINED: it is a counter, not a
    // property of the messages, so it cannot be re-derived, and it is the only
    // record of what the survivor absorbed. Zeroing it here would make the undo
    // unable to give it back. Inert while merged — scopeToUnmerged hides
    // tombstones from the list and the badge, and nothing sums this column.
    expect(source.unread_count).toBe(1)

    // 1 (accounts) + 2 (studio) — the conversation's unread mail, in one place.
    expect(ticketRow(T_STUDIO.id).unread_count).toBe(3)
  })

  it('keeps a closed_at the source already had', async () => {
    setupDb({
      tickets: [
        { ...T_STUDIO },
        { ...T_ACCOUNTS, status: 'closed', closed_at: '2026-08-05T00:00:00Z' },
      ],
    })
    expect((await post(T_ACCOUNTS.id, { into: T_STUDIO.id })).status).toBe(200)
    expect(ticketRow(T_ACCOUNTS.id).closed_at).toBe('2026-08-05T00:00:00Z')
  })

  // The gate is loadTicketForUser on BOTH tickets. Checking only the one named
  // in the path would let a caller move mail INTO a studio they cannot see —
  // or, run the other way, out of one.
  it('404s when the caller cannot open the TARGET, writing nothing', async () => {
    // The coach holds studio@ only, so T_STUDIO (the source here) opens fine
    // and T_ACCOUNTS (the target) does not.
    getCurrentUser.mockResolvedValue(COACH)
    setupDb({ grants: [GRANT_STUDIO] })

    expect((await post(T_STUDIO.id, { into: T_ACCOUNTS.id })).status).toBe(404)

    expect(writesTo(db)).toEqual([])
    const source = ticketRow(T_STUDIO.id)
    expect(source.merged_into_id ?? null).toBeNull()
    expect(source.status).toBe('open')
    expect(messageRow('m-native').ticket_id).toBe(T_STUDIO.id)
  })

  it('404s on merging a ticket into itself', async () => {
    expect((await post(T_STUDIO.id, { into: T_STUDIO.id })).status).toBe(404)
    expect(writesTo(db)).toEqual([])
  })

  it('404s on merging a ticket that is already merged', async () => {
    // Chains are refused so unmerge stays exact (canMerge, EMAIL-MERGE.2).
    setupDb({
      tickets: [{ ...T_STUDIO }, { ...T_ACCOUNTS, merged_into_id: T_STUDIO.id }],
    })
    expect((await post(T_ACCOUNTS.id, { into: T_STUDIO.id })).status).toBe(404)
    expect(writesTo(db)).toEqual([])
  })

  // ORDER IS LOAD-BEARING: there is no transaction, so the tombstone is stamped
  // LAST. A failed reparent must leave the source LIVE — a hidden ticket whose
  // messages never moved is silent loss, and nothing would ever surface it.
  //
  // failWrites, not `errors`: the injected-error harness fails every operation
  // on the table, which would refuse at the absorbed-merge READ above and never
  // reach the reparent this test is about.
  // MAIL-SPAM.1 review — the picker merges related → current, so from the Spam
  // view a live thread could be folded INTO a quarantined ticket and purged
  // with it 30 days later. Refused at the rule, in both directions, before any
  // write; 404 like every other canMerge refusal (the reason goes to the log).
  it('404s on merging a LIVE ticket into a QUARANTINED one, writing nothing', async () => {
    setupDb({ tickets: [
      { ...T_STUDIO, is_spam: true, spam_flagged_at: '2026-08-01T00:00:00Z' },
      { ...T_ACCOUNTS },
    ] })
    const res = await post(T_ACCOUNTS.id, { into: T_STUDIO.id })
    expect(res.status).toBe(404)
    expect(writesTo(db)).toEqual([])
    expect(messageRow('m-src').ticket_id).toBe(T_ACCOUNTS.id)
    expect(ticketRow(T_ACCOUNTS.id).merged_into_id ?? null).toBeNull()
  })

  it('404s on merging a QUARANTINED ticket into a LIVE one, writing nothing', async () => {
    setupDb({ tickets: [
      { ...T_STUDIO },
      { ...T_ACCOUNTS, is_spam: true, spam_flagged_at: '2026-08-01T00:00:00Z' },
    ] })
    const res = await post(T_ACCOUNTS.id, { into: T_STUDIO.id })
    expect(res.status).toBe(404)
    expect(writesTo(db)).toEqual([])
    expect(ticketRow(T_ACCOUNTS.id).merged_into_id ?? null).toBeNull()
  })

  it('merges two QUARANTINED tickets — the flag must match, not be clear', async () => {
    setupDb({ tickets: [
      { ...T_STUDIO, is_spam: true, spam_flagged_at: '2026-08-01T00:00:00Z' },
      { ...T_ACCOUNTS, is_spam: true, spam_flagged_at: '2026-08-01T00:00:00Z' },
    ] })
    expect((await post(T_ACCOUNTS.id, { into: T_STUDIO.id })).status).toBe(200)
    expect(ticketRow(T_ACCOUNTS.id).merged_into_id).toBe(T_STUDIO.id)
  })

  it('500s without tombstoning the source when the reparent fails', async () => {
    failWrites(db, ['email_inbox_messages'])
    expect((await post(T_ACCOUNTS.id, { into: T_STUDIO.id })).status).toBe(500)

    expect(updatesTo(db, 'email_tickets')).toEqual([])
    const source = ticketRow(T_ACCOUNTS.id)
    expect(source.merged_into_id ?? null).toBeNull()
    expect(source.status).toBe('open')
  })

  // A SURVIVOR IS NOT A TOMBSTONE — the hole canMerge cannot see. A→B leaves B
  // mergeable, and B→C would re-stamp A's rows as having come from B, after
  // which unmerging A restores nothing. Both directions are refused: the check
  // is about either ticket having absorbed, not about which side it is on.
  it('404s when the SOURCE has already absorbed a merge', async () => {
    setupDb({
      messages: [
        M_TARGET_NATIVE,
        { ...M_SOURCE, merged_from_ticket_id: 'aaaaaaa9-0000-4000-8000-000000000009' },
      ],
    })
    expect((await post(T_ACCOUNTS.id, { into: T_STUDIO.id })).status).toBe(404)
    expect(writesTo(db)).toEqual([])
  })

  it('404s when the TARGET has already absorbed a merge', async () => {
    setupDb({
      messages: [
        { ...M_TARGET_NATIVE, merged_from_ticket_id: 'aaaaaaa9-0000-4000-8000-000000000009' },
        M_SOURCE,
      ],
    })
    expect((await post(T_ACCOUNTS.id, { into: T_STUDIO.id })).status).toBe(404)
    expect(writesTo(db)).toEqual([])
  })

  it('merges again once the earlier merge has been undone', async () => {
    // The refusal is a state, not a life sentence: clearing the stamps makes
    // the ticket mergeable again, which is what "unmerge first" has to mean.
    expect((await post(T_ACCOUNTS.id, { into: T_STUDIO.id })).status).toBe(200)
    expect((await del(T_ACCOUNTS.id)).status).toBe(200)
    expect((await post(T_ACCOUNTS.id, { into: T_STUDIO.id })).status).toBe(200)
  })

  it('500s when the absorbed-merge check itself fails — a failed lookup is not "none"', async () => {
    setupDb({
      errors: { email_inbox_messages: { code: '42703', message: 'column merged_from_ticket_id does not exist' } },
    })
    expect((await post(T_ACCOUNTS.id, { into: T_STUDIO.id })).status).toBe(500)
    expect(writesTo(db)).toEqual([])
  })

  // The same-source race: two operators merging one ticket into DIFFERENT
  // targets. Without the conditional both stamps land, the pointer names one
  // survivor while the messages sit split across two, and the undo restores
  // half a conversation. Simulated by having the concurrent writer land while
  // this request is between its reparent and its stamp.
  it('409s instead of overwriting a pointer somebody else just set', async () => {
    const otherTarget = 'aaaaaaa7-0000-4000-8000-000000000007'
    const realFrom = db.from
    db.from = (table) => {
      const b = realFrom(table)
      if (table !== 'email_inbox_messages') return b
      const origUpdate = b.update
      b.update = (payload) => {
        // …the other operator's merge commits here, between our two writes.
        ticketRow(T_ACCOUNTS.id).merged_into_id = otherTarget
        return origUpdate(payload)
      }
      return b
    }

    expect((await post(T_ACCOUNTS.id, { into: T_STUDIO.id })).status).toBe(409)
    // Their pointer stands — ours never overwrote it.
    expect(ticketRow(T_ACCOUNTS.id).merged_into_id).toBe(otherTarget)
  })
})

describe('DELETE …/merge — unmerge', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await del(T_ACCOUNTS.id)).status).toBe(401)
    expect(writesTo(db)).toEqual([])
  })

  it('404s on a ticket that was never merged', async () => {
    expect((await del(T_ACCOUNTS.id)).status).toBe(404)
    expect(writesTo(db)).toEqual([])
  })

  // THE TEST THAT PROVES merged_from_ticket_id DOES REAL WORK. A route that
  // moved back everything on the target — the obvious .eq('ticket_id', target)
  // spelling — would hand the target's OWN message to the source and pass every
  // other assertion in this file.
  it('restores exactly the rows that moved, and nothing else', async () => {
    expect((await post(T_ACCOUNTS.id, { into: T_STUDIO.id })).status).toBe(200)
    expect((await del(T_ACCOUNTS.id)).status).toBe(200)

    // The source got its own message back, unstamped.
    expect(messageRow('m-src').ticket_id).toBe(T_ACCOUNTS.id)
    expect(messageRow('m-src').merged_from_ticket_id).toBeNull()
    // The target kept the one it always had.
    expect(messageRow('m-native').ticket_id).toBe(T_STUDIO.id)

    const source = ticketRow(T_ACCOUNTS.id)
    expect(source.merged_into_id).toBeNull()
    expect(source.merged_at).toBeNull()
    expect(source.merged_by).toBeNull()
  })

  // THE UNDO CLAIM, STATED AS A ROUND TRIP. Moving the rows back is not enough:
  // left alone the survivor keeps the summed unread and advertises a last
  // message that has left it — a preview and a sort key it does not own. The
  // fixtures' stored trios are exactly what their messages imply, so anything
  // the derivation gets wrong shows up here as drift rather than as a pass.
  const DENORMALISED = ['unread_count', 'first_response_at', 'last_message_at', 'last_message_direction', 'last_message_preview']
  const snapshot = (id) => Object.fromEntries(DENORMALISED.map(k => [k, ticketRow(id)[k]]))

  it('leaves BOTH tickets as they were — a merge and its undo cancel out', async () => {
    const before = { source: snapshot(T_ACCOUNTS.id), target: snapshot(T_STUDIO.id) }

    expect((await post(T_ACCOUNTS.id, { into: T_STUDIO.id })).status).toBe(200)
    // Mid-merge the survivor really did absorb the lot — otherwise this test
    // would pass just as well against a merge that did nothing.
    expect(ticketRow(T_STUDIO.id).unread_count).toBe(3)
    expect(ticketRow(T_STUDIO.id).last_message_preview).toBe('My DD bounced')

    expect((await del(T_ACCOUNTS.id)).status).toBe(200)

    expect(snapshot(T_ACCOUNTS.id)).toEqual(before.source)
    expect(snapshot(T_STUDIO.id)).toEqual(before.target)
  })

  it('does not drive the survivor’s unread negative when somebody read it meanwhile', async () => {
    expect((await post(T_ACCOUNTS.id, { into: T_STUDIO.id })).status).toBe(200)
    ticketRow(T_STUDIO.id).unread_count = 0   // an operator opened it
    expect((await del(T_ACCOUNTS.id)).status).toBe(200)
    expect(ticketRow(T_STUDIO.id).unread_count).toBe(0)
  })

  // The mirror of the merge's own gate. This route takes messages OFF the
  // survivor and rewrites its counters, so gating only the tombstone would let
  // a caller reshape a ticket they cannot see.
  it('404s when the caller cannot open the SURVIVOR, writing nothing', async () => {
    // The coach holds studio@ only. Tombstone on studio@, survivor on accounts@.
    getCurrentUser.mockResolvedValue(COACH)
    setupDb({
      grants: [GRANT_STUDIO],
      tickets: [{ ...T_ACCOUNTS }, { ...T_STUDIO, merged_into_id: T_ACCOUNTS.id }],
      messages: [{ ...M_TARGET_NATIVE, ticket_id: T_ACCOUNTS.id, merged_from_ticket_id: T_STUDIO.id }],
    })
    expect((await del(T_STUDIO.id)).status).toBe(404)
    expect(writesTo(db)).toEqual([])
  })

  it('404s when the caller cannot open the tombstone', async () => {
    getCurrentUser.mockResolvedValue(COACH)
    setupDb({
      grants: [GRANT_STUDIO],
      tickets: [{ ...T_STUDIO }, { ...T_ACCOUNTS, merged_into_id: T_STUDIO.id }],
    })
    expect((await del(T_ACCOUNTS.id)).status).toBe(404)
    expect(writesTo(db)).toEqual([])
  })

  // Same ordering argument as the merge: the pointer clears LAST, so a failed
  // move-back leaves a tombstone that can simply be unmerged again. Clearing it
  // first and then failing would strand the stamped rows on the survivor with
  // no route left that looks for them.
  it('500s without clearing the pointer when the move-back fails', async () => {
    setupDb({
      tickets: [{ ...T_STUDIO }, { ...T_ACCOUNTS, merged_into_id: T_STUDIO.id }],
      messages: [M_TARGET_NATIVE, { ...M_SOURCE, ticket_id: T_STUDIO.id, merged_from_ticket_id: T_ACCOUNTS.id }],
      errors: { email_inbox_messages: { code: 'XX000', message: 'messages exploded' } },
    })
    expect((await del(T_ACCOUNTS.id)).status).toBe(500)

    expect(updatesTo(db, 'email_tickets')).toEqual([])
    expect(ticketRow(T_ACCOUNTS.id).merged_into_id).toBe(T_STUDIO.id)
  })
})

// Moving a member's correspondence between tickets is the most audit-worthy act
// on this surface, and the ticket rows do NOT keep the story: the undo nulls
// merged_by, so without these events a conversation that was moved twice leaves
// no trace of either move.
describe('…/merge — audit trail', () => {
  it('records the merge with both tickets and how many messages moved', async () => {
    await post(T_ACCOUNTS.id, { into: T_STUDIO.id })
    const [audit] = insertsInto(db, 'audit_events')
    expect(audit.payload.action).toBe('email_ticket.merged')
    expect(audit.payload.actor_id).toBe(OWNER.id)
    expect(audit.payload.target_resource).toBe(`email_ticket/${T_ACCOUNTS.id}`)
    expect(audit.payload.details.merged_into_id).toBe(T_STUDIO.id)
    expect(audit.payload.details.message_count).toBe(1)
  })

  it('records the undo, which is the only surviving record of it', async () => {
    await post(T_ACCOUNTS.id, { into: T_STUDIO.id })
    await del(T_ACCOUNTS.id)
    const audit = insertsInto(db, 'audit_events').at(-1)
    expect(audit.payload.action).toBe('email_ticket.unmerged')
    expect(audit.payload.target_resource).toBe(`email_ticket/${T_ACCOUNTS.id}`)
    expect(audit.payload.details.unmerged_from_id).toBe(T_STUDIO.id)
    expect(audit.payload.details.message_count).toBe(1)
    // The row itself now says nothing — merged_by is null again.
    expect(ticketRow(T_ACCOUNTS.id).merged_by).toBeNull()
  })

  it('never fails the operation because the log failed', async () => {
    setupDb({ errors: { audit_events: { code: 'XX000', message: 'audit exploded' } } })
    expect((await post(T_ACCOUNTS.id, { into: T_STUDIO.id })).status).toBe(200)
    expect(ticketRow(T_ACCOUNTS.id).merged_into_id).toBe(T_STUDIO.id)
    expect((await del(T_ACCOUNTS.id)).status).toBe(200)
    expect(ticketRow(T_ACCOUNTS.id).merged_into_id).toBeNull()
  })
})
