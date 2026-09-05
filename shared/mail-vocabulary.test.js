// MAIL-ARCH.2 — the shared Mail vocabulary, tested where it lives. The web
// suite (src/components/mail/mail-display.test.js) still exercises the same
// functions through the barrel; this file is the seam's own contract, and it
// runs under the plain node environment because mobile does.
import { describe, it, expect } from 'vitest'
import {
  ARCHIVED_STATUS, isArchived, needsReply, isUnread, isSpam,
  MAIL_VIEWS, DEFAULT_MAIL_VIEW, mailView,
} from './mail-vocabulary.js'

describe('isArchived — the stamp is the whole answer', () => {
  it('a boolean stamp decides, whatever the status says', () => {
    // 🔴 The swipe-reopen case: a legacy `solved` row the server stamped LIVE.
    expect(isArchived({ status: 'solved', archived: false })).toBe(false)
    expect(isArchived({ status: 'closed', archived: false })).toBe(false)
    expect(isArchived({ status: 'open', archived: true })).toBe(true)
  })

  it('without a stamp only `closed` is archived — solved, pending and open are live', () => {
    expect(ARCHIVED_STATUS).toBe('closed')
    expect(isArchived({ status: 'closed' })).toBe(true)
    for (const status of ['open', 'pending', 'solved', undefined, null, 'junk']) {
      expect(isArchived({ status }), String(status)).toBe(false)
    }
  })

  it('a non-boolean `archived` is not a stamp', () => {
    // 'true' from a query string, 1 from a bad join — neither is the server's word.
    expect(isArchived({ status: 'closed', archived: 'false' })).toBe(true)
    expect(isArchived({ status: 'open', archived: 1 })).toBe(false)
    expect(isArchived({ status: 'open', archived: null })).toBe(false)
  })

  it('is safe on junk', () => {
    expect(isArchived(null)).toBe(false)
    expect(isArchived(undefined)).toBe(false)
    expect(isArchived({})).toBe(false)
  })
})

describe('needsReply — the stamp, then the identical fallback expression', () => {
  it('a boolean stamp decides', () => {
    expect(needsReply({ needs_reply: true, status: 'closed', last_message_direction: 'outbound' })).toBe(true)
    expect(needsReply({ needs_reply: false, status: 'open', last_message_direction: 'inbound' })).toBe(false)
  })

  it('falls back to open + last word inbound, and nothing else', () => {
    expect(needsReply({ status: 'open', last_message_direction: 'inbound' })).toBe(true)
    expect(needsReply({ status: 'open', last_message_direction: 'outbound' })).toBe(false)
    expect(needsReply({ status: 'open', last_message_direction: null })).toBe(false)
    expect(needsReply({ status: 'pending', last_message_direction: 'inbound' })).toBe(false)
    expect(needsReply({ status: 'solved', last_message_direction: 'inbound' })).toBe(false)
    expect(needsReply({ status: 'closed', last_message_direction: 'inbound' })).toBe(false)
    expect(needsReply(null)).toBe(false)
  })
})

describe('isUnread / isSpam', () => {
  it('unread is truthy `unread` — deliberately tolerant, unlike isSpam', () => {
    expect(isUnread({ unread: true })).toBe(true)
    expect(isUnread({ unread: false })).toBe(false)
    // The list route writes a boolean (`c.unread > 0`), but a count that
    // reached here unconverted must still read as unread: under-reading an
    // unread row hides mail, over-reading one costs a bold line. Pinned so a
    // "tidy-up" to `=== true` is a decision, not a drive-by.
    expect(isUnread({ unread: 1 })).toBe(true)
    expect(isUnread({ unread: 0 })).toBe(false)
    expect(isUnread({})).toBe(false)
    expect(isUnread(null)).toBe(false)
  })

  it('spam is STRICTLY is_spam === true — a row from before the column reads live', () => {
    expect(isSpam({ is_spam: true })).toBe(true)
    expect(isSpam({ is_spam: false })).toBe(false)
    expect(isSpam({ is_spam: 'true' })).toBe(false)
    expect(isSpam({ is_spam: 1 })).toBe(false)
    expect(isSpam({})).toBe(false)
    expect(isSpam(null)).toBe(false)
  })
})

describe('the views', () => {
  it('are the five wire ids, in strip order, frozen', () => {
    expect(MAIL_VIEWS.map(v => v.id)).toEqual(['inbox', 'needs_reply', 'sent', 'archived', 'spam'])
    expect(Object.isFrozen(MAIL_VIEWS)).toBe(true)
    expect(DEFAULT_MAIL_VIEW).toBe('inbox')
  })

  it('each carries a label, a hint and its own empty copy', () => {
    for (const v of MAIL_VIEWS) {
      for (const k of ['label', 'hint', 'emptyTitle', 'emptyDescription']) {
        expect(typeof v[k], `${v.id}.${k}`).toBe('string')
        expect(v[k].length, `${v.id}.${k}`).toBeGreaterThan(0)
      }
    }
    // "Nothing here" means different things per view — no two share a title.
    expect(new Set(MAIL_VIEWS.map(v => v.emptyTitle)).size).toBe(MAIL_VIEWS.length)
  })

  it('mailView never returns undefined', () => {
    expect(mailView('spam').label).toBe('Spam')
    expect(mailView('archived').id).toBe('archived')
    expect(mailView('nope')).toBe(MAIL_VIEWS[0])
    expect(mailView(undefined)).toBe(MAIL_VIEWS[0])
    expect(mailView(null).id).toBe(DEFAULT_MAIL_VIEW)
  })
})
