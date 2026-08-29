// MAIL-TRIAL.B — the things in _helpers.js that a route test cannot reach.
// (RETIRE-TICKETS.1 removed the INBOX_SURFACE cross-module pin that lived
// here — both constants are gone with the surface split, mig 578, and the
// assertion had silently become `undefined === undefined`.)

import { describe, it, expect } from 'vitest'
import {
  isNeedsReply, isArchived,
  loadConversationCounts, MESSAGE_SCAN_LIMIT,
} from './_helpers'

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
    expect(counts.get('t1')).toEqual({ messages: 3, unread: 1, hasAttachments: false })
    // An outbound message with no seen_at is not unread — our own replies are
    // not something to read.
    expect(counts.get('t2')).toEqual({ messages: 1, unread: 0, hasAttachments: false })
  })

  // ── the attachment embed ──────────────────────────────────────────────
  //
  // Reuses the SAME scan rather than a second query — see the file header on
  // loadConversationCounts. email_ticket_attachments has no ticket_id (only
  // message_id), so the only way to answer "does this conversation have an
  // attachment" off one pass is the embedded resource on each message row.
  describe('has_attachments — via the embedded email_ticket_attachments(id)', () => {
    it('is true when ANY message in the conversation embeds an attachment row', async () => {
      const { counts } = await loadConversationCounts(
        scanReturning({
          data: [
            { ticket_id: 't1', direction: 'inbound', seen_at: '2026-08-06T09:00:00Z', email_ticket_attachments: [] },
            { ticket_id: 't1', direction: 'outbound', seen_at: null, email_ticket_attachments: [{ id: 'att-1' }] },
          ],
          error: null,
        }),
        ['t1']
      )
      expect(counts.get('t1').hasAttachments).toBe(true)
    })

    it('is false when no message in the conversation embeds one', async () => {
      const { counts } = await loadConversationCounts(
        scanReturning({
          data: [{ ticket_id: 't1', direction: 'inbound', seen_at: null, email_ticket_attachments: [] }],
          error: null,
        }),
        ['t1']
      )
      expect(counts.get('t1').hasAttachments).toBe(false)
    })

    // 🔴 A SKIPPED attachment (storage_path null, skipped_reason set — the XOR
    // constraint) still has a ROW: the email genuinely arrived with a file, we
    // just could not store it. The embed cannot see the XOR itself (it only
    // selects `id`), so any row present at all — stored or skipped — counts.
    it('counts a skipped-but-present attachment row as "has attachments" too', async () => {
      const { counts } = await loadConversationCounts(
        scanReturning({
          data: [{ ticket_id: 't1', direction: 'inbound', seen_at: null, email_ticket_attachments: [{ id: 'skipped-1' }] }],
          error: null,
        }),
        ['t1']
      )
      expect(counts.get('t1').hasAttachments).toBe(true)
    })

    // The embed is absent altogether on a row (a stub that never sends it, or
    // a PostgREST response shaped without it) — must read as "none", not throw.
    it('treats a missing embed field as no attachments rather than throwing', async () => {
      const { counts } = await loadConversationCounts(
        scanReturning({ data: [{ ticket_id: 't1', direction: 'inbound', seen_at: null }], error: null }),
        ['t1']
      )
      expect(counts.get('t1').hasAttachments).toBe(false)
    })

    it('selects the embedded resource on the SAME scan — no second query', async () => {
      let selectedFields = null
      const db = {
        from: () => ({
          select: (fields) => {
            selectedFields = fields
            return {
              in: () => ({
                order: () => ({
                  limit: () => Promise.resolve({ data: [], error: null }),
                }),
              }),
            }
          },
        }),
      }
      await loadConversationCounts(db, ['t1'])
      expect(selectedFields).toContain('email_ticket_attachments(id)')
    })
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
