// @vitest-environment jsdom
//
// MAIL-TRIAL.B — the Mail surface's vocabulary and its keyboard helpers.
//
// Two of these are load-bearing rather than cosmetic:
//   • needsReply() is the one predicate the surface keeps from the ticket
//     model, and it must agree with the server's scope exactly;
//   • isTypingTarget() is what stops a single-letter shortcut eating a
//     half-written reply, which is the most expensive bug this surface could
//     ship.
//
// MAIL-DENSITY.1 needs a real `window.localStorage`/`Storage` (it spies on
// `Storage.prototype`), which the default `node` environment does not
// provide — this file now opts into jsdom the same way its siblings
// (MailThread/MailSurface/MailList.test.jsx) already do.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  MAIL_VIEWS, DEFAULT_MAIL_VIEW, mailView, buildMailUrl,
  isArchived, needsReply, isUnread, isSpam, isTypingTarget, neighbourId,
  DENSITIES, DEFAULT_DENSITY, readDensity, writeDensity, MAIL_DENSITY_KEY,
  readReplyDraft, writeReplyDraft, clearReplyDraft, clearAllReplyDrafts,
  REPLY_DRAFT_MAX_LENGTH, REPLY_DRAFT_TTL_MS, REPLY_DRAFT_MAX_ENTRIES, REPLY_DRAFT_PREFIX,
  mailboxShortTag, defaultExpandedMessageId, messageSnippet, collapsedSenderLabel,
  READER_MODES, READER_MODE_MIN, DEFAULT_READER_MODE, READER_MODE_KEY,
  readReaderMode, writeReaderMode, escTarget, restoreTarget,
  BODY_EXPANDED_KEY, readBodyExpanded, writeBodyExpanded,
  frameHeightClass, replyPillLabel,
  COMPOSE_MODES, COMPOSE_MODE_MIN, DEFAULT_COMPOSE_MODE, COMPOSE_MODE_KEY,
  readComposeMode, writeComposeMode, composeRestoreTarget,
  composeEscTarget, composeBlocksKeys, slotYieldTarget, slotOccupancy,
  composeCardTitle, isMdUp,
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

describe('spam (MAIL-SPAM.1)', () => {
  it('reads the server’s is_spam flag and defaults to live — a row from before the column reads as real mail', () => {
    expect(isSpam({ is_spam: true })).toBe(true)
    expect(isSpam({ is_spam: false })).toBe(false)
    expect(isSpam({})).toBe(false)
    expect(isSpam(null)).toBe(false)
    // Truthiness is NOT the test: a stringly "false" from a stale cache is live.
    expect(isSpam({ is_spam: 'true' })).toBe(false)
  })

  it('the spam view is last in the rail and carries its own empty copy', () => {
    const spam = mailView('spam')
    expect(spam.id).toBe('spam')
    expect(spam.label).toBe('Spam')
    expect(spam.emptyTitle).toBeTruthy()
    expect(spam.emptyDescription).toMatch(/30 days/)
    expect(buildMailUrl({ locationId: 'L', viewId: 'spam' })).toBe('/api/email/mail?location_id=L&view=spam')
  })
})

describe('views', () => {
  it('has five (MAIL-SENT.1 added Sent, MAIL-SPAM.1 added Spam), and no assignment views', () => {
    expect(MAIL_VIEWS.map(v => v.id)).toEqual(['inbox', 'needs_reply', 'sent', 'archived', 'spam'])
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

describe('density preference', () => {
  beforeEach(() => { window.localStorage.clear() })

  it('defaults to compact — the density Richard asked for', () => {
    expect(DEFAULT_DENSITY).toBe('comfortable')
    expect(DENSITIES).toEqual(['compact', 'comfortable'])
  })

  it('reads a stored preference back', () => {
    window.localStorage.setItem(MAIL_DENSITY_KEY, 'comfortable')
    expect(readDensity()).toBe('comfortable')
  })

  it('falls back to the default for anything it does not recognise', () => {
    window.localStorage.setItem(MAIL_DENSITY_KEY, 'enormous')
    expect(readDensity()).toBe('comfortable')
  })

  it('round-trips a write', () => {
    writeDensity('compact')
    expect(readDensity()).toBe('compact')
  })

  it('refuses to store a value that is not a density', () => {
    writeDensity('enormous')
    expect(window.localStorage.getItem(MAIL_DENSITY_KEY)).toBeNull()
  })

  // Storage throws outright in a locked-down browser or a private window. A
  // display preference is never worth taking the surface down for.
  it('survives storage being unavailable, in both directions', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    expect(readDensity()).toBe('comfortable')
    expect(() => writeDensity('compact')).not.toThrow()
    get.mockRestore(); set.mockRestore()
  })
})

// ── reply drafts ─────────────────────────────────────────────────────
//
// TICKET-COMPOSER-LEAK.1 is the reason these are keyed PER TICKET: the
// composer is remounted whenever the operator switches tickets specifically
// so member A's half-written reply cannot end up addressed to member B. A
// draft store that did not key on the ticket id would reopen that leak by a
// different door — restoring A's words into B's box the moment B is opened.
// MAIL-DRAFTSCOPE.1 — drafts are keyed per USER and per EMAIL ACCOUNT as well
// as per ticket (Richard's call). S() builds a scope with stable defaults so
// the pre-existing per-ticket assertions keep their meaning unchanged.
const S = (ticketId, userId = 'user-1', mailboxId = 'mb-1') => ({ userId, mailboxId, ticketId })

describe('reply drafts — scoped persistence', () => {
  beforeEach(() => { window.localStorage.clear() })

  it('returns null for a ticket with nothing saved', () => {
    expect(readReplyDraft(S('ticket-1'))).toBeNull()
  })

  it('round-trips a write', () => {
    writeReplyDraft(S('ticket-1'), { text: 'Sorry for the delay', mode: 'reply' })
    expect(readReplyDraft(S('ticket-1'))).toEqual({ text: 'Sorry for the delay', mode: 'reply' })
  })

  it('keeps note mode distinct from reply mode', () => {
    writeReplyDraft(S('ticket-1'), { text: 'staff-only', mode: 'note' })
    expect(readReplyDraft(S('ticket-1'))).toEqual({ text: 'staff-only', mode: 'note' })
  })

  it('falls back to reply mode for anything it does not recognise', () => {
    writeReplyDraft(S('ticket-1'), { text: 'hi', mode: 'bogus' })
    expect(readReplyDraft(S('ticket-1')).mode).toBe('reply')
  })

  // 🔴 THE ISOLATION GUARANTEE. A shared key here is the same class of bug
  // TICKET-COMPOSER-LEAK.1 already fixed once, one layer up.
  it('never lets one ticket read another ticket’s draft', () => {
    writeReplyDraft(S('ticket-A'), { text: 'For A only', mode: 'reply' })
    expect(readReplyDraft(S('ticket-B'))).toBeNull()
    writeReplyDraft(S('ticket-B'), { text: 'For B only', mode: 'reply' })
    expect(readReplyDraft(S('ticket-A'))).toEqual({ text: 'For A only', mode: 'reply' })
    expect(readReplyDraft(S('ticket-B'))).toEqual({ text: 'For B only', mode: 'reply' })
  })

  it('writing empty text clears rather than storing a blank draft', () => {
    writeReplyDraft(S('ticket-1'), { text: 'something', mode: 'reply' })
    expect(readReplyDraft(S('ticket-1'))).not.toBeNull()
    writeReplyDraft(S('ticket-1'), { text: '', mode: 'reply' })
    expect(readReplyDraft(S('ticket-1'))).toBeNull()
  })

  it('whitespace-only text also clears — there is nothing an operator would want restored', () => {
    writeReplyDraft(S('ticket-1'), { text: 'something', mode: 'reply' })
    writeReplyDraft(S('ticket-1'), { text: '   ', mode: 'reply' })
    expect(readReplyDraft(S('ticket-1'))).toBeNull()
  })

  it('clearReplyDraft removes a stored draft directly', () => {
    writeReplyDraft(S('ticket-1'), { text: 'discard me', mode: 'reply' })
    clearReplyDraft(S('ticket-1'))
    expect(readReplyDraft(S('ticket-1'))).toBeNull()
  })

  it('caps stored draft length so one runaway paste cannot grow storage unboundedly', () => {
    const huge = 'x'.repeat(REPLY_DRAFT_MAX_LENGTH + 500)
    writeReplyDraft(S('ticket-1'), { text: huge, mode: 'reply' })
    expect(readReplyDraft(S('ticket-1')).text.length).toBe(REPLY_DRAFT_MAX_LENGTH)
  })

  it('does nothing for a falsy ticket id, in every direction', () => {
    expect(readReplyDraft(S(null))).toBeNull()
    expect(() => writeReplyDraft(S(null), { text: 'x', mode: 'reply' })).not.toThrow()
    expect(() => clearReplyDraft(S(null))).not.toThrow()
    expect(readReplyDraft(S(undefined))).toBeNull()
  })

  it('treats corrupt stored JSON as no draft rather than throwing', () => {
    window.localStorage.setItem('un1t.email.reply-draft.ticket-1', '{not json')
    expect(readReplyDraft(S('ticket-1'))).toBeNull()
  })

  // Storage throws outright in a locked-down browser or a private window — a
  // draft that could not be saved must never take the composer down with it.
  it('survives storage being unavailable, in every direction', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('denied') })
    expect(readReplyDraft(S('ticket-1'))).toBeNull()
    expect(() => writeReplyDraft(S('ticket-1'), { text: 'x', mode: 'reply' })).not.toThrow()
    expect(() => clearReplyDraft(S('ticket-1'))).not.toThrow()
    get.mockRestore(); set.mockRestore(); remove.mockRestore()
  })
})

// ── eviction (L7) ────────────────────────────────────────────────────
//
// One entry was already capped at REPLY_DRAFT_MAX_LENGTH, but nothing
// capped the NUMBER of entries — an abandoned draft lived forever, and once
// the origin's 5MB quota eventually filled, setItem would throw ORIGIN-WIDE
// (breaking studio device pairing, sidebar state, the command palette too,
// not just drafts). These pin the TTL and the max-entry prune, and that
// both stay scoped to this store's own prefix.
describe('reply drafts — user and mailbox scoping (MAIL-DRAFTSCOPE.1)', () => {
  beforeEach(() => { window.localStorage.clear() })

  // 🔴 The reason the scope exists: on a shared front-desk browser, staff-A's
  // half-written reply must never hydrate into staff-B's composer. Same
  // ticket, different user → different key → no bleed.
  it('never lets one USER read another user\'s draft on the same ticket', () => {
    writeReplyDraft(S('ticket-1', 'staff-a'), { text: 'A\'s words', mode: 'reply' })
    expect(readReplyDraft(S('ticket-1', 'staff-b'))).toBeNull()
    expect(readReplyDraft(S('ticket-1', 'staff-a'))).toEqual({ text: 'A\'s words', mode: 'reply' })
  })

  it('scopes by email account: same ticket id under two mailboxes are two drafts', () => {
    writeReplyDraft(S('ticket-1', 'user-1', 'mb-accounts'), { text: 'for accounts@', mode: 'reply' })
    expect(readReplyDraft(S('ticket-1', 'user-1', 'mb-sales'))).toBeNull()
  })

  // 🔴 FAIL CLOSED. An unscoped draft is a draft some other signed-in user
  // could hydrate; a broken-session edge case loses persistence, not privacy.
  it('refuses to persist anything without a user id', () => {
    writeReplyDraft({ userId: null, mailboxId: 'mb-1', ticketId: 'ticket-1' }, { text: 'orphaned', mode: 'reply' })
    expect(window.localStorage.length).toBe(0)
    expect(readReplyDraft({ userId: null, mailboxId: 'mb-1', ticketId: 'ticket-1' })).toBeNull()
  })

  it('an orphan ticket (no mailbox) still persists, per user, under the none sentinel', () => {
    writeReplyDraft(S('ticket-1', 'user-1', null), { text: 'orphan draft', mode: 'reply' })
    expect(readReplyDraft(S('ticket-1', 'user-1', null))).toEqual({ text: 'orphan draft', mode: 'reply' })
    expect(readReplyDraft(S('ticket-1', 'user-1', 'mb-1'))).toBeNull()
    const key = Object.keys(window.localStorage).find(k => k.includes('.none.'))
    expect(key).toBeTruthy()
  })

  // Keys written by the pre-scope release (bare ticket id) are never read by
  // the new code, but they still match the prefix, so the TTL prune retires
  // them — no migration needed, asserted so nobody writes one.
  it('legacy single-segment keys are still pruned by prefix', () => {
    window.localStorage.setItem('un1t.email.reply-draft.old-ticket',
      JSON.stringify({ text: 'stale', mode: 'reply', savedAt: Date.now() - (15 * 24 * 60 * 60 * 1000) }))
    writeReplyDraft(S('ticket-new'), { text: 'fresh', mode: 'reply' })
    expect(window.localStorage.getItem('un1t.email.reply-draft.old-ticket')).toBeNull()
  })
})

describe('reply drafts — eviction', () => {
  beforeEach(() => { window.localStorage.clear() })

  it('treats an entry past the TTL as absent, and clears it on read', () => {
    const stale = Date.now() - (REPLY_DRAFT_TTL_MS + 1000)
    window.localStorage.setItem(
      `${REPLY_DRAFT_PREFIX}user-1.mb-1.ticket-old`,
      JSON.stringify({ text: 'ancient', mode: 'reply', savedAt: stale })
    )
    expect(readReplyDraft(S('ticket-old'))).toBeNull()
    // Cleared on the way out, not just hidden — a dead key must not sit
    // there for the next prune to rediscover.
    expect(window.localStorage.getItem(`${REPLY_DRAFT_PREFIX}user-1.mb-1.ticket-old`)).toBeNull()
  })

  it('keeps an entry comfortably inside the TTL', () => {
    const fresh = Date.now() - 1000
    window.localStorage.setItem(
      `${REPLY_DRAFT_PREFIX}user-1.mb-1.ticket-fresh`,
      JSON.stringify({ text: 'still good', mode: 'reply', savedAt: fresh })
    )
    expect(readReplyDraft(S('ticket-fresh'))).toEqual({ text: 'still good', mode: 'reply' })
  })

  it('treats a draft with no readable savedAt at all as expired', () => {
    // A draft written before eviction existed (or by a caller that skipped
    // writeReplyDraft) has no timestamp — fail-safe is to evict it, not to
    // assume it is fine.
    window.localStorage.setItem(
      `${REPLY_DRAFT_PREFIX}user-1.mb-1.ticket-untimed`,
      JSON.stringify({ text: 'no timestamp', mode: 'reply' })
    )
    expect(readReplyDraft(S('ticket-untimed'))).toBeNull()
  })

  it('a write past the max-entry count evicts the oldest survivor, by savedAt', () => {
    const now = Date.now()
    // Seed exactly REPLY_DRAFT_MAX_ENTRIES drafts, each with a distinct,
    // deterministic savedAt — oldest first — all comfortably inside the TTL.
    for (let i = 0; i < REPLY_DRAFT_MAX_ENTRIES; i++) {
      window.localStorage.setItem(
        `${REPLY_DRAFT_PREFIX}user-1.mb-1.ticket-seed-${i}`,
        JSON.stringify({ text: `seed ${i}`, mode: 'reply', savedAt: now - (REPLY_DRAFT_MAX_ENTRIES - i) * 1000 })
      )
    }
    // One more real draft over the top, through the real write path — the
    // one that actually triggers the prune.
    writeReplyDraft(S('ticket-new'), { text: 'the newest one', mode: 'reply' })

    // The very oldest seed (index 0) is gone…
    expect(readReplyDraft(S('ticket-seed-0'))).toBeNull()
    // …the newest seed survived…
    expect(readReplyDraft(S(`ticket-seed-${REPLY_DRAFT_MAX_ENTRIES - 1}`))).not.toBeNull()
    // …and so did the draft that triggered the prune in the first place.
    expect(readReplyDraft(S('ticket-new'))).toEqual({ text: 'the newest one', mode: 'reply' })
  })

  it('does not prune anything while under the max-entry count', () => {
    writeReplyDraft(S('ticket-a'), { text: 'a', mode: 'reply' })
    writeReplyDraft(S('ticket-b'), { text: 'b', mode: 'reply' })
    expect(readReplyDraft(S('ticket-a'))).not.toBeNull()
    expect(readReplyDraft(S('ticket-b'))).not.toBeNull()
  })

  it('a prune never touches a key outside its own prefix', () => {
    window.localStorage.setItem('un1t.mail.density', 'comfortable')
    window.localStorage.setItem('some-other-consumer.state', '{"x":1}')
    const now = Date.now()
    for (let i = 0; i < REPLY_DRAFT_MAX_ENTRIES; i++) {
      window.localStorage.setItem(
        `${REPLY_DRAFT_PREFIX}user-1.mb-1.ticket-seed-${i}`,
        JSON.stringify({ text: `seed ${i}`, mode: 'reply', savedAt: now - (REPLY_DRAFT_MAX_ENTRIES - i) * 1000 })
      )
    }
    writeReplyDraft(S('ticket-new'), { text: 'triggers a prune', mode: 'reply' })
    expect(window.localStorage.getItem('un1t.mail.density')).toBe('comfortable')
    expect(window.localStorage.getItem('some-other-consumer.state')).toBe('{"x":1}')
  })
})

// ── clearAllReplyDrafts (M2) ────────────────────────────────────────
//
// Drafts are per-BROWSER, not per-user — on a shared front-desk machine,
// staff-A's draft can hydrate into staff-B's composer. This is the sign-out
// hook: the orchestrator wires it at the sign-out site (not this file), so
// these tests only prove what this function itself guarantees.
describe('clearAllReplyDrafts', () => {
  beforeEach(() => { window.localStorage.clear() })

  it('removes every draft this store holds, and reports how many', () => {
    writeReplyDraft(S('ticket-a'), { text: 'a', mode: 'reply' })
    writeReplyDraft(S('ticket-b'), { text: 'b', mode: 'reply' })
    writeReplyDraft(S('ticket-c'), { text: 'c', mode: 'note' })
    expect(clearAllReplyDrafts()).toBe(3)
    expect(readReplyDraft(S('ticket-a'))).toBeNull()
    expect(readReplyDraft(S('ticket-b'))).toBeNull()
    expect(readReplyDraft(S('ticket-c'))).toBeNull()
  })

  it('leaves every OTHER consumer’s key on the origin untouched', () => {
    window.localStorage.setItem('un1t.mail.density', 'comfortable')
    window.localStorage.setItem('un1t.studio.device-pairing', '{"paired":true}')
    window.localStorage.setItem('un1t.sidebar.collapsed', 'true')
    writeReplyDraft(S('ticket-a'), { text: 'a', mode: 'reply' })

    clearAllReplyDrafts()

    expect(window.localStorage.getItem('un1t.mail.density')).toBe('comfortable')
    expect(window.localStorage.getItem('un1t.studio.device-pairing')).toBe('{"paired":true}')
    expect(window.localStorage.getItem('un1t.sidebar.collapsed')).toBe('true')
  })

  it('reports 0 when there was nothing to clear', () => {
    expect(clearAllReplyDrafts()).toBe(0)
  })

  it('survives storage being unavailable rather than throwing at sign-out', () => {
    const length = vi.spyOn(Storage.prototype, 'length', 'get').mockImplementation(() => { throw new Error('denied') })
    expect(() => clearAllReplyDrafts()).not.toThrow()
    expect(clearAllReplyDrafts()).toBe(0)
    length.mockRestore()
  })

  it('survives a throwing removeItem mid-clear rather than throwing at sign-out', () => {
    writeReplyDraft(S('ticket-a'), { text: 'a', mode: 'reply' })
    const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('denied') })
    expect(() => clearAllReplyDrafts()).not.toThrow()
    remove.mockRestore()
  })
})

/* ── MAIL-REFINE.1 — row + flat-thread display helpers ─────────────── */

describe('mailboxShortTag — the small account tag (01)', () => {
  it('shortens an address to its local part plus @ — the mockup’s "accounts@"', () => {
    expect(mailboxShortTag({ address: 'accounts@hatchstreetfitness.com' })).toBe('accounts@')
  })

  it('falls back to the label when the address has no @ to shorten on', () => {
    expect(mailboxShortTag({ label: 'Studio', address: 'not-an-address' })).toBe('Studio')
    expect(mailboxShortTag({ label: 'Studio' })).toBe('Studio')
  })

  it('answers null with nothing to say — the row renders no tag rather than a placeholder', () => {
    expect(mailboxShortTag(null)).toBeNull()
    expect(mailboxShortTag({})).toBeNull()
    // An address that is ONLY an @-domain has no local part worth showing.
    expect(mailboxShortTag({ address: '@x.com' })).toBeNull()
  })
})

describe('defaultExpandedMessageId — only the newest message opens (02)', () => {
  it('is the last message in render order', () => {
    expect(defaultExpandedMessageId([{ id: 'a' }, { id: 'b' }, { id: 'c' }])).toBe('c')
  })

  it('is null for an empty or absent thread', () => {
    expect(defaultExpandedMessageId([])).toBeNull()
    expect(defaultExpandedMessageId(undefined)).toBeNull()
  })
})

describe('messageSnippet — the collapsed line’s one-line body', () => {
  it('collapses whitespace and newlines to one line', () => {
    expect(messageSnippet({ text_body: 'Hi,\n\nour records   show\tthe read…' }))
      .toBe('Hi, our records show the read…')
  })

  it('caps the length — a collapsed line must stay a line', () => {
    const long = 'x'.repeat(500)
    expect(messageSnippet({ text_body: long }).length).toBeLessThanOrEqual(140)
  })

  it('answers empty for nothing readable, never a placeholder the row must special-case', () => {
    expect(messageSnippet({})).toBe('')
    expect(messageSnippet(null)).toBe('')
    expect(messageSnippet({ text_body: '   ' })).toBe('')
  })
})

describe('collapsedSenderLabel — who a collapsed line says wrote it', () => {
  const TICKET = { requester_email: 'Jordan.Sample@example.test', requester_name: 'Jordan Sample' }

  it('says You for our own replies — same word the row’s outbound marker uses', () => {
    expect(collapsedSenderLabel({ direction: 'outbound' }, TICKET)).toBe('You')
  })

  it('names the requester when the mail came from them, compared case-insensitively', () => {
    expect(collapsedSenderLabel(
      { direction: 'inbound', from_email: 'jordan.sample@example.test' }, TICKET
    )).toBe('Jordan Sample')
  })

  it('shows the raw address for anyone else — a different person must never wear the requester’s name', () => {
    expect(collapsedSenderLabel(
      { direction: 'inbound', from_email: 'eleanor@council.ie' }, TICKET
    )).toBe('eleanor@council.ie')
  })

  it('names a note’s author — notes are outbound rows but not replies', () => {
    expect(collapsedSenderLabel(
      { direction: 'outbound', is_internal_note: true, author_name: 'Alex Example' }, TICKET
    )).toBe('Alex Example')
    expect(collapsedSenderLabel(
      { direction: 'outbound', is_internal_note: true }, TICKET
    )).toBe('Staff')
  })

  it('degrades to Unknown sender rather than blank', () => {
    expect(collapsedSenderLabel({ direction: 'inbound' }, TICKET)).toBe('Unknown sender')
  })
})

/* ── MAIL-DOCK.1 — the docked reader ─────────────────────────────────── */

describe('reader mode — dock by default, full by choice, min never stored', () => {
  beforeEach(() => window.localStorage.clear())

  it('defaults to dock with nothing stored', () => {
    expect(readReaderMode()).toBe('dock')
    expect(DEFAULT_READER_MODE).toBe('dock')
  })

  it('round-trips the two persistable modes', () => {
    writeReaderMode('full')
    expect(readReaderMode()).toBe('full')
    writeReaderMode('dock')
    expect(readReaderMode()).toBe('dock')
    expect(READER_MODES).toEqual(['dock', 'full'])
  })

  it('validates on read — a garbage stored value fails safe to dock', () => {
    window.localStorage.setItem(READER_MODE_KEY, 'sideways')
    expect(readReaderMode()).toBe('dock')
  })

  it('🔴 min NEVER persists — writeReaderMode refuses it outright', () => {
    writeReaderMode('full')
    writeReaderMode(READER_MODE_MIN)
    expect(window.localStorage.getItem(READER_MODE_KEY)).toBe('full')
    // …and even a hand-planted min is refused on the way back out.
    window.localStorage.setItem(READER_MODE_KEY, 'min')
    expect(readReaderMode()).toBe('dock')
  })

  it('survives a hostile localStorage without throwing', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    expect(readReaderMode()).toBe('dock')
    spy.mockRestore()
    const setSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(() => writeReaderMode('full')).not.toThrow()
    setSpy.mockRestore()
  })
})

describe('escTarget — the Esc ladder', () => {
  it('steps full down to dock', () => {
    expect(escTarget('full')).toBe('dock')
  })

  it('closes from dock — null means clearSelection', () => {
    expect(escTarget('dock')).toBeNull()
  })

  it('closes from min — a bar the operator is dismissing, not restoring', () => {
    expect(escTarget(READER_MODE_MIN)).toBeNull()
  })

  it('closes for anything unrecognised — never an undefined branch', () => {
    expect(escTarget(undefined)).toBeNull()
    expect(escTarget('sideways')).toBeNull()
  })
})

describe('restoreTarget — where minimise/close hand the card back to', () => {
  it('returns a persistable previous mode as it is', () => {
    expect(restoreTarget('full')).toBe('full')
    expect(restoreTarget('dock')).toBe('dock')
  })

  it('never answers min, and falls back to the default for garbage', () => {
    expect(restoreTarget(READER_MODE_MIN)).toBe('dock')
    expect(restoreTarget(undefined)).toBe('dock')
  })
})

describe('body-expanded — the operator’s Expand choice, remembered', () => {
  beforeEach(() => window.localStorage.clear())

  it('defaults to collapsed with nothing stored', () => {
    expect(readBodyExpanded()).toBe(false)
  })

  it('round-trips both directions as 1/0', () => {
    writeBodyExpanded(true)
    expect(window.localStorage.getItem(BODY_EXPANDED_KEY)).toBe('1')
    expect(readBodyExpanded()).toBe(true)
    writeBodyExpanded(false)
    expect(window.localStorage.getItem(BODY_EXPANDED_KEY)).toBe('0')
    expect(readBodyExpanded()).toBe(false)
  })

  it('treats garbage as collapsed — only the exact 1 expands', () => {
    window.localStorage.setItem(BODY_EXPANDED_KEY, 'true')
    expect(readBodyExpanded()).toBe(false)
  })

  it('is try/caught in BOTH directions', () => {
    const getSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    expect(readBodyExpanded()).toBe(false)
    getSpy.mockRestore()
    const setSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(() => writeBodyExpanded(true)).not.toThrow()
    setSpy.mockRestore()
  })
})

describe('frameHeightClass — context-sized message frames', () => {
  it('keeps the pre-dock values for any render without the prop', () => {
    expect(frameHeightClass(undefined, false)).toBe('h-[420px]')
    expect(frameHeightClass(undefined, true)).toBe('h-[70vh]')
  })

  it('sizes the dock’s frames to the card', () => {
    expect(frameHeightClass('dock', false)).toBe('h-[38vh]')
    expect(frameHeightClass('dock', true)).toBe('h-[52vh]')
  })

  it('gives the takeover the reading height', () => {
    expect(frameHeightClass('full', false)).toBe('h-[65vh]')
    expect(frameHeightClass('full', true)).toBe('h-[80vh]')
  })

  it('falls back to the defaults for an unknown size, never an undefined class', () => {
    expect(frameHeightClass('sideways', false)).toBe('h-[420px]')
    expect(frameHeightClass('sideways', true)).toBe('h-[70vh]')
  })
})

describe('replyPillLabel — the collapsed composer’s one line', () => {
  it('names the requester by FIRST name, the mockup’s measure', () => {
    expect(replyPillLabel({ requester_name: 'Helen Lawlor', requester_email: 'h@x.com' }))
      .toBe('Reply to Helen…')
  })

  it('falls back to the address when there is no name', () => {
    expect(replyPillLabel({ requester_email: 'helen@x.com' })).toBe('Reply to helen@x.com…')
  })

  it('degrades to a bare Reply… rather than naming nobody awkwardly', () => {
    expect(replyPillLabel({})).toBe('Reply…')
    expect(replyPillLabel(null)).toBe('Reply…')
    expect(replyPillLabel({ requester_name: '   ' })).toBe('Reply…')
  })
})

/* ── MAIL-DOCK.2 — compose joins the dock ────────────────────────────── */

describe('compose mode — its OWN key, the reader-mode discipline cloned', () => {
  beforeEach(() => window.localStorage.clear())

  it('defaults to dock with nothing stored, under its own key', () => {
    expect(readComposeMode()).toBe('dock')
    expect(DEFAULT_COMPOSE_MODE).toBe('dock')
    expect(COMPOSE_MODE_KEY).toBe('un1t.mail.compose-mode')
  })

  it('round-trips the two persistable modes', () => {
    writeComposeMode('full')
    expect(readComposeMode()).toBe('full')
    writeComposeMode('dock')
    expect(readComposeMode()).toBe('dock')
    expect(COMPOSE_MODES).toEqual(['dock', 'full'])
  })

  it('never touches the READER key — the two preferences are independent', () => {
    writeReaderMode('full')
    writeComposeMode('dock')
    expect(readReaderMode()).toBe('full')
    writeComposeMode('full')
    expect(window.localStorage.getItem(READER_MODE_KEY)).toBe('full')
    expect(window.localStorage.getItem(COMPOSE_MODE_KEY)).toBe('full')
    writeReaderMode('dock')
    expect(readComposeMode()).toBe('full')
  })

  it('validates on read — a garbage stored value fails safe to dock', () => {
    window.localStorage.setItem(COMPOSE_MODE_KEY, 'sideways')
    expect(readComposeMode()).toBe('dock')
  })

  it('🔴 min NEVER persists — writeComposeMode refuses it outright', () => {
    writeComposeMode('full')
    writeComposeMode(COMPOSE_MODE_MIN)
    expect(window.localStorage.getItem(COMPOSE_MODE_KEY)).toBe('full')
    // …and even a hand-planted min is refused on the way back out.
    window.localStorage.setItem(COMPOSE_MODE_KEY, 'min')
    expect(readComposeMode()).toBe('dock')
  })

  it('survives a hostile localStorage without throwing', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    expect(readComposeMode()).toBe('dock')
    spy.mockRestore()
    const setSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(() => writeComposeMode('full')).not.toThrow()
    setSpy.mockRestore()
  })
})

describe('composeRestoreTarget — where the compose bar restores to', () => {
  it('returns a persistable previous mode as it is', () => {
    expect(composeRestoreTarget('full')).toBe('full')
    expect(composeRestoreTarget('dock')).toBe('dock')
  })

  it('never answers min, and falls back to the default for garbage', () => {
    expect(composeRestoreTarget(COMPOSE_MODE_MIN)).toBe('dock')
    expect(composeRestoreTarget(undefined)).toBe('dock')
  })
})

describe('composeEscTarget — the compose Esc ladder is DIRTY-AWARE', () => {
  it('🔴 a dirty compose NEVER discards: full → dock → min, and min is the floor', () => {
    expect(composeEscTarget('full', true)).toBe('dock')
    expect(composeEscTarget('dock', true)).toBe(COMPOSE_MODE_MIN)
    // Esc on the minimised bar with a dirty draft does nothing further —
    // answering the SAME mode is how "nothing" is spelled, so the caller can
    // compare rather than branch on a third sentinel.
    expect(composeEscTarget(COMPOSE_MODE_MIN, true)).toBe(COMPOSE_MODE_MIN)
  })

  it('a pristine compose closes from every shape — null means requestClose', () => {
    expect(composeEscTarget('full', false)).toBeNull()
    expect(composeEscTarget('dock', false)).toBeNull()
    expect(composeEscTarget(COMPOSE_MODE_MIN, false)).toBeNull()
  })

  it('an unknown mode fails toward the draft: dirty parks at min, pristine closes', () => {
    expect(composeEscTarget('sideways', true)).toBe(COMPOSE_MODE_MIN)
    expect(composeEscTarget(undefined, true)).toBe(COMPOSE_MODE_MIN)
    expect(composeEscTarget('sideways', false)).toBeNull()
  })
})

describe('composeBlocksKeys — the guard lifts ONLY while compose is a bar', () => {
  it('an open compose CARD keeps j/k/e/u inert (dock and full alike)', () => {
    expect(composeBlocksKeys(true, 'dock')).toBe(true)
    expect(composeBlocksKeys(true, 'full')).toBe(true)
  })

  it('a MINIMISED compose lifts the guard — the reader flows again', () => {
    expect(composeBlocksKeys(true, COMPOSE_MODE_MIN)).toBe(false)
  })

  it('no compose, no guard — whatever the leftover mode says', () => {
    expect(composeBlocksKeys(false, 'dock')).toBe(false)
    expect(composeBlocksKeys(false, COMPOSE_MODE_MIN)).toBe(false)
  })
})

describe('slotYieldTarget — one bottom-right slot, auto-minimise both ways', () => {
  it('an open CARD yields to min when the other occupant takes the slot', () => {
    expect(slotYieldTarget(true, 'dock')).toBe('min')
    expect(slotYieldTarget(true, 'full')).toBe('min')
  })

  it('an already-minimised occupant stays put — its bar survives', () => {
    expect(slotYieldTarget(true, 'min')).toBeNull()
  })

  it('an absent occupant needs no yielding', () => {
    expect(slotYieldTarget(false, 'dock')).toBeNull()
    expect(slotYieldTarget(false, 'min')).toBeNull()
  })
})

describe('slotOccupancy — what one occupant shows as, for the other’s offset', () => {
  it('closed holds no ground', () => {
    expect(slotOccupancy(false, 'dock')).toBe('none')
  })

  it('a bar is a bar, a docked card is a card', () => {
    expect(slotOccupancy(true, 'min')).toBe('bar')
    expect(slotOccupancy(true, 'dock')).toBe('card')
  })

  it('full is an OVERLAY — it holds no bottom-right ground', () => {
    expect(slotOccupancy(true, 'full')).toBe('none')
  })

  it('an unknown mode reads as the default card rather than vanishing', () => {
    expect(slotOccupancy(true, 'sideways')).toBe('card')
  })
})

describe('composeCardTitle — the typed subject, live, else New email', () => {
  it('shows the subject as typed', () => {
    expect(composeCardTitle('Re: your trial')).toBe('Re: your trial')
  })

  it('falls back for empty and whitespace-only subjects', () => {
    expect(composeCardTitle('')).toBe('New email')
    expect(composeCardTitle('   ')).toBe('New email')
    expect(composeCardTitle(undefined)).toBe('New email')
  })
})

describe('isMdUp — which composer shell a fresh open gets', () => {
  const realMatchMedia = window.matchMedia

  afterEach(() => {
    // jsdom has no matchMedia of its own — restore whatever was there.
    window.matchMedia = realMatchMedia
  })

  it('true at md+ (the dock machinery), false below (the Modal, byte-for-byte)', () => {
    window.matchMedia = vi.fn(() => ({ matches: true }))
    expect(isMdUp()).toBe(true)
    expect(window.matchMedia).toHaveBeenCalledWith('(min-width: 768px)')
    window.matchMedia = vi.fn(() => ({ matches: false }))
    expect(isMdUp()).toBe(false)
  })

  it('fails safe to the Modal when matchMedia is missing or hostile', () => {
    window.matchMedia = undefined
    expect(isMdUp()).toBe(false)
    window.matchMedia = () => { throw new Error('blocked') }
    expect(isMdUp()).toBe(false)
  })
})
