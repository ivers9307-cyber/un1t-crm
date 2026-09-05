// MAIL-GDPR.1 (review fix 3) — `scrub_warnings` used to travel back from both
// delete routes and reach nobody: the single-delete dialog navigated away
// without reading `data`, and the bulk modal rendered three buckets, not this
// one. These pin the pure shaping both components render from.
//
// A failure is a STATEMENT that failed (an UPDATE on email_tickets, a storage
// remove), not a row count — so the copy says "steps", never "rows".

import { describe, it, expect } from 'vitest'
import { summariseScrubWarnings, scrubIncompleteRows } from './scrub-warnings'

describe('summariseScrubWarnings', () => {
  it('is null for nothing to say — the clean path renders no notice', () => {
    expect(summariseScrubWarnings([])).toBeNull()
    expect(summariseScrubWarnings(undefined)).toBeNull()
    expect(summariseScrubWarnings(null)).toBeNull()
  })

  it('counts the failed steps and names each table once', () => {
    const out = summariseScrubWarnings([
      { table: 'email_inbox_messages', op: 'update', message: 'boom' },
      { table: 'email_inbox_messages', op: 'update', message: 'boom again' },
      { table: 'storage.email-attachments', op: 'remove', message: 'down' },
    ])
    expect(out).toEqual({
      count: 3,
      tables: ['email_inbox_messages', 'storage.email-attachments'],
      text: '3 mail scrub steps failed (email_inbox_messages, storage.email-attachments)',
    })
  })

  it('singular for one', () => {
    expect(summariseScrubWarnings([{ table: 'email_tickets', op: 'update', message: 'x' }]).text)
      .toBe('1 mail scrub step failed (email_tickets)')
  })

  it('tolerates a failure with no table (the route\'s thrown-scrub shape names "mail")', () => {
    expect(summariseScrubWarnings([{ table: 'mail', op: 'scrub', message: 'unexpected' }, { message: 'bare' }]))
      .toEqual({ count: 2, tables: ['mail'], text: '2 mail scrub steps failed (mail)' })
  })
})

describe('scrubIncompleteRows', () => {
  it('shapes the bulk route\'s per-contact warnings into the modal\'s { id, name, reason } rows', () => {
    const rows = scrubIncompleteRows([
      { id: 'c2', name: 'Bea', failures: [{ table: 'email_tickets', op: 'update', message: 'boom' }] },
    ])
    expect(rows).toEqual([{ id: 'c2', name: 'Bea', reason: '1 mail scrub step failed (email_tickets)' }])
  })

  it('falls back to the id when the contact had no name, and drops entries with nothing failed', () => {
    expect(scrubIncompleteRows([
      { id: 'c3', name: null, failures: [{ table: 'email_tickets' }] },
      { id: 'c4', name: 'Clean', failures: [] },
    ])).toEqual([{ id: 'c3', name: 'c3', reason: '1 mail scrub step failed (email_tickets)' }])
    expect(scrubIncompleteRows(undefined)).toEqual([])
  })
})
