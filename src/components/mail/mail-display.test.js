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

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  MAIL_VIEWS, DEFAULT_MAIL_VIEW, mailView, buildMailUrl,
  isArchived, needsReply, isUnread, isTypingTarget, neighbourId,
  DENSITIES, DEFAULT_DENSITY, readDensity, writeDensity, MAIL_DENSITY_KEY,
  readReplyDraft, writeReplyDraft, clearReplyDraft, clearAllReplyDrafts,
  REPLY_DRAFT_MAX_LENGTH, REPLY_DRAFT_TTL_MS, REPLY_DRAFT_MAX_ENTRIES, REPLY_DRAFT_PREFIX,
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

describe('density preference', () => {
  beforeEach(() => { window.localStorage.clear() })

  it('defaults to compact — the density Richard asked for', () => {
    expect(DEFAULT_DENSITY).toBe('compact')
    expect(DENSITIES).toEqual(['compact', 'comfortable'])
  })

  it('reads a stored preference back', () => {
    window.localStorage.setItem(MAIL_DENSITY_KEY, 'comfortable')
    expect(readDensity()).toBe('comfortable')
  })

  it('falls back to the default for anything it does not recognise', () => {
    window.localStorage.setItem(MAIL_DENSITY_KEY, 'enormous')
    expect(readDensity()).toBe('compact')
  })

  it('round-trips a write', () => {
    writeDensity('comfortable')
    expect(readDensity()).toBe('comfortable')
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
    expect(readDensity()).toBe('compact')
    expect(() => writeDensity('comfortable')).not.toThrow()
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
