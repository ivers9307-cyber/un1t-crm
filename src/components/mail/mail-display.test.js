// MAIL-TRIAL.B — the Mail surface's vocabulary and its keyboard helpers.
//
// Two of these are load-bearing rather than cosmetic:
//   • needsReply() is the one predicate the surface keeps from the ticket
//     model, and it must agree with the server's scope exactly;
//   • isTypingTarget() is what stops a single-letter shortcut eating a
//     half-written reply, which is the most expensive bug this surface could
//     ship.

import { describe, it, expect } from 'vitest'
import {
  MAIL_VIEWS, DEFAULT_MAIL_VIEW, mailView, buildMailUrl,
  isArchived, needsReply, isUnread, isTypingTarget, neighbourId,
} from './mail-display'

describe('the two states a conversation can be in', () => {
  it('archived is status=closed and nothing else', () => {
    expect(isArchived({ status: 'closed' })).toBe(true)
    expect(isArchived({ status: 'open' })).toBe(false)
    // `solved` is a legacy value this surface never writes. It is NOT archived
    // — it stays in the inbox, exactly as the list route decides.
    expect(isArchived({ status: 'solved' })).toBe(false)
    expect(isArchived({ status: 'pending' })).toBe(false)
  })

  it('prefers the flag the server stamped over re-deriving it', () => {
    expect(isArchived({ archived: true, status: 'open' })).toBe(true)
    expect(isArchived({ archived: false, status: 'closed' })).toBe(false)
  })
})

describe('needs-reply — the one thing a mail client cannot tell you', () => {
  it('is open AND the last word was theirs', () => {
    expect(needsReply({ status: 'open', last_message_direction: 'inbound' })).toBe(true)
  })

  it('is not "open"', () => {
    // A conversation we started is open with an outbound last message, and
    // there is nothing to do about mail we just sent.
    expect(needsReply({ status: 'open', last_message_direction: 'outbound' })).toBe(false)
  })

  it('is not "they wrote last"', () => {
    // Pending means we already replied and the ball is with the member.
    expect(needsReply({ status: 'pending', last_message_direction: 'inbound' })).toBe(false)
    expect(needsReply({ status: 'closed', last_message_direction: 'inbound' })).toBe(false)
  })

  it('prefers the server’s flag, so the list and the filter cannot disagree', () => {
    expect(needsReply({ needs_reply: true, status: 'closed', last_message_direction: 'outbound' })).toBe(true)
    expect(needsReply({ needs_reply: false, status: 'open', last_message_direction: 'inbound' })).toBe(false)
  })
})

describe('unread', () => {
  it('reads the server’s flag and defaults to read', () => {
    expect(isUnread({ unread: true })).toBe(true)
    expect(isUnread({ unread: false })).toBe(false)
    // Missing means the count scan could not answer. Rendering that as unread
    // would light up an entire inbox on a failed query.
    expect(isUnread({})).toBe(false)
  })
})

describe('views', () => {
  it('has three, and no assignment views', () => {
    expect(MAIL_VIEWS.map(v => v.id)).toEqual(['inbox', 'needs_reply', 'archived'])
    expect(MAIL_VIEWS.map(v => v.id)).not.toContain('mine')
    expect(MAIL_VIEWS.map(v => v.id)).not.toContain('unassigned')
  })

  it('always answers with a view, so no caller has to guard', () => {
    expect(mailView('archived').id).toBe('archived')
    expect(mailView('nonsense').id).toBe(DEFAULT_MAIL_VIEW)
    expect(mailView(undefined).id).toBe(DEFAULT_MAIL_VIEW)
  })

  it('gives every view its own empty copy', () => {
    // "Nothing here" means three different things, and only one of them is
    // good news.
    const titles = MAIL_VIEWS.map(v => v.emptyTitle)
    expect(new Set(titles).size).toBe(MAIL_VIEWS.length)
  })
})

describe('buildMailUrl', () => {
  it('omits the default view, so one list is one URL', () => {
    expect(buildMailUrl({ locationId: 'loc-1', viewId: 'inbox' }))
      .toBe('/api/email/mail?location_id=loc-1')
  })

  it('carries the mailbox, the view and the cursor', () => {
    expect(buildMailUrl({ locationId: 'loc-1', mailboxId: 'mb-1', viewId: 'archived', before: '2026-08-06T09:00:00Z' }))
      .toBe('/api/email/mail?location_id=loc-1&mailbox_id=mb-1&view=archived&before=2026-08-06T09%3A00%3A00Z')
  })
})

// 🔴 The guard that stops `e` archiving somebody's conversation while they are
// typing the word "we".
describe('isTypingTarget', () => {
  it('is true for every control an operator types into', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(isTypingTarget({ tagName })).toBe(true)
    }
  })

  it('is true for a contentEditable host, which is none of those tags', () => {
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
  })

  // 🔴 Modal focuses its own panel — a plain <div role="dialog"> — and neither
  // composer autofocuses a field, so the operator's FIRST keystroke into a
  // fresh compose window lands on a node that is none of the tags above.
  it('is true anywhere inside a dialog, including the dialog panel itself', () => {
    const panel = { tagName: 'DIV', closest: (sel) => (sel === '[role="dialog"]' ? panel : null) }
    expect(isTypingTarget(panel)).toBe(true)
    const buttonInDialog = { tagName: 'BUTTON', closest: (sel) => (sel === '[role="dialog"]' ? panel : null) }
    expect(isTypingTarget(buttonInDialog)).toBe(true)
  })

  it('is false for the page itself', () => {
    const noDialog = { closest: () => null }
    expect(isTypingTarget({ tagName: 'DIV', ...noDialog })).toBe(false)
    expect(isTypingTarget({ tagName: 'BUTTON', ...noDialog })).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
    // An element with no closest() at all must not throw — jsdom detached nodes
    // and plain test doubles both hit this.
    expect(isTypingTarget({ tagName: 'DIV' })).toBe(false)
  })
})

describe('neighbourId — j and k', () => {
  const ids = ['a', 'b', 'c']

  it('moves forward and back', () => {
    expect(neighbourId(ids, 'a', 1)).toBe('b')
    expect(neighbourId(ids, 'b', -1)).toBe('a')
  })

  it('does NOT wrap at either end', () => {
    // Wrapping jumps an operator from the oldest conversation to the newest
    // with no visible cause — and on a paged list the "end" is only the end of
    // what has been loaded.
    expect(neighbourId(ids, 'c', 1)).toBeNull()
    expect(neighbourId(ids, 'a', -1)).toBeNull()
  })

  it('lands on the first item with nothing selected, in either direction', () => {
    expect(neighbourId(ids, null, 1)).toBe('a')
    expect(neighbourId(ids, null, -1)).toBe('a')
  })

  it('answers null for an empty list rather than undefined', () => {
    expect(neighbourId([], 'a', 1)).toBeNull()
    expect(neighbourId(undefined, 'a', 1)).toBeNull()
  })
})
