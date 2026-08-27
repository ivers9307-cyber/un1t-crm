// MAIL-TRIAL.B — the two things in _helpers.js that a route test cannot reach.

import { describe, it, expect } from 'vitest'
import { INBOX_SURFACE as WRITEBACK_INBOX_SURFACE } from '@/lib/mail/imap-writeback'
import {
  INBOX_SURFACE, isNeedsReply, isArchived,
  loadConversationCounts, MESSAGE_SCAN_LIMIT,
} from './_helpers'

// 🔴 ONE CONSTANT, TWO FILES THAT MUST NOT IMPORT EACH OTHER.
//
// imap-writeback.js re-reads the mailbox row and refuses any write for a
// mailbox whose `surface` is not its own INBOX_SURFACE. This surface decides
// what to LIST with its own copy — deliberately its own, because importing the
// write-back module would pull imapflow into the list route's cold start for
// no reason at all.
//
// The two must agree or the surface is incoherent: a list showing a mailbox the
// write helper then refuses is an Archive button that 404s on the row it just
// drew. Nothing structural can enforce that across the boundary, so this
// assertion does.
describe('the surface flag', () => {
  it('matches the value the IMAP write guard refuses on', () => {
    expect(INBOX_SURFACE).toBe(WRITEBACK_INBOX_SURFACE)
  })
})

describe('the two predicates the list stamps on every row', () => {
  it('needs-reply is open AND their word was last', () => {
    expect(isNeedsReply({ status: 'open', last_message_direction: 'inbound' })).toBe(true)
    expect(isNeedsReply({ status: 'open', last_message_direction: 'outbound' })).toBe(false)
    expect(isNeedsReply({ status: 'pending', last_message_direction: 'inbound' })).toBe(false)
    expect(isNeedsReply(null)).toBe(false)
  })

  it('archived is exactly `closed` — there is no second lifecycle', () => {
    expect(isArchived({ status: 'closed' })).toBe(true)
    for (const status of ['open', 'pending', 'solved']) {
      expect(isArchived({ status })).toBe(false)
    }
  })
})

// A stub rather than the shared fake: this is about what happens at the edge of
// the scan, and building a thousand fixture rows to reach it would be slower
// and less clear than saying what the query returned.
function scanReturning(result) {
  return {
    from: () => ({
      select: () => ({
        in: () => ({
          order: () => ({
            limit: () => Promise.resolve(result),
          }),
        }),
      }),
    }),
  }
}

describe('loadConversationCounts', () => {
  it('counts messages and unread inbound separately, per conversation', async () => {
    const { counts, partial, unavailable } = await loadConversationCounts(
      scanReturning({
        data: [
          { ticket_id: 't1', direction: 'inbound', seen_at: null },
          { ticket_id: 't1', direction: 'inbound', seen_at: '2026-08-06T09:00:00Z' },
          { ticket_id: 't1', direction: 'outbound', seen_at: null },
          { ticket_id: 't2', direction: 'inbound', seen_at: '2026-08-06T09:00:00Z' },
        ],
        error: null,
      }),
      ['t1', 't2']
    )
    expect(partial).toBe(false)
    expect(unavailable).toBe(false)
    expect(counts.get('t1')).toEqual({ messages: 3, unread: 1 })
    // An outbound message with no seen_at is not unread — our own replies are
    // not something to read.
    expect(counts.get('t2')).toEqual({ messages: 1, unread: 0 })
  })

  // 🔴 Rows arrive ordered by ticket_id, so hitting the cap starves a SUFFIX of
  // the page. Reporting the counts we did get would render the last
  // conversations as "no messages, all read" — a confident wrong answer rather
  // than a missing one.
  it('reports NOTHING rather than a partial answer when the scan hits its cap', async () => {
    const rows = Array.from({ length: MESSAGE_SCAN_LIMIT }, (_, i) => ({
      ticket_id: 't1', direction: 'inbound', seen_at: null, id: i,
    }))
    const { counts, partial } = await loadConversationCounts(scanReturning({ data: rows, error: null }), ['t1'])
    expect(partial).toBe(true)
    expect(counts.size).toBe(0)
  })

  it('keeps a FAILED scan distinct from a truncated one', async () => {
    // They need different sentences: one is "we could not read the messages",
    // the other is "this page is bigger than one scan".
    const { partial, unavailable } = await loadConversationCounts(
      scanReturning({ data: null, error: { code: '42703', message: 'column "seen_at" does not exist' } }),
      ['t1']
    )
    expect(unavailable).toBe(true)
    expect(partial).toBe(false)
  })

  it('does no work at all for an empty page', async () => {
    // The stub would throw if it were called, which is the assertion.
    const { counts } = await loadConversationCounts({ from: () => { throw new Error('queried') } }, [])
    expect(counts.size).toBe(0)
  })
})
