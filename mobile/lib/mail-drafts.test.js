// mobile/lib/mail-drafts.test.js — MOBILE-MAIL-THREAD.1 (mockup §04).
//
// The decisions the thread screen branches on, tested off-screen (contract
// rule: screens have no render harness, so every branchable decision lives
// here). Four families:
//
//   1. The reply-draft store — the MOBILE mirror of the web store in
//      src/components/mail/mail-display.js, over AsyncStorage. The SEMANTICS
//      are the contract: keyed per user + mailbox + ticket, fail CLOSED with
//      no user id, 14-day TTL, 30-entry LRU prune scoped strictly to its own
//      prefix, empty text = the clear path.
//   2. The hydration decision — the live-typing-wins clobber trap. Web's
//      first cut called setText('') when async hydration landed and ERASED
//      words mid-sentence (TicketReplyBox.jsx); mobile hydration is async by
//      construction (AsyncStorage + the ticket load), so the same trap is
//      structural here and the rule is tested as a pure function.
//   3. Thread collapse — all but the newest two messages fold to one-line
//      rows until tapped.
//   4. Reply-attachment maths + the composer send gate — the 7 MiB ceiling
//      (checked BEFORE send: a red chip, never a failed send), the 10-file
//      cap, and the one function that says whether Send is live.
//
// AsyncStorage is mocked with a factory BEFORE import (the physical-cache.js
// idiom): the RN runtime must never load under vitest's Node environment.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// The three RN-touching deps of ./email-api, mocked with the exact factories
// its own test uses — imported here ONLY to pin this lib's restated
// attachment limits against A's exported constants (they cannot be imported
// into mail-drafts.js itself: './supabase' pulls the whole RN runtime, which
// must never load under vitest, and would drag it into every consumer of
// this otherwise pure lib).
vi.mock('./api', () => ({ api: vi.fn() }))
vi.mock('./supabase', () => ({ supabase: { storage: { from: vi.fn() } } }))
vi.mock('./upload-bytes', () => ({ readFileAsArrayBuffer: vi.fn() }))

const store = new Map()
let failWrites = false
let failReads = false
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (k) => {
      if (failReads) throw new Error('storage unavailable')
      return store.has(k) ? store.get(k) : null
    }),
    setItem: vi.fn(async (k, v) => {
      if (failWrites) throw new Error('disk full')
      store.set(k, String(v))
    }),
    removeItem: vi.fn(async (k) => { store.delete(k) }),
    getAllKeys: vi.fn(async () => {
      if (failReads) throw new Error('storage unavailable')
      return [...store.keys()]
    }),
    multiGet: vi.fn(async (keys) => {
      if (failReads) throw new Error('storage unavailable')
      return keys.map(k => [k, store.has(k) ? store.get(k) : null])
    }),
    multiRemove: vi.fn(async (keys) => { for (const k of keys) store.delete(k) }),
  },
}))

const {
  REPLY_DRAFT_PREFIX,
  REPLY_DRAFT_MODES,
  REPLY_DRAFT_MAX_LENGTH,
  REPLY_DRAFT_TTL_MS,
  REPLY_DRAFT_MAX_ENTRIES,
  replyDraftKey,
  readReplyDraft,
  writeReplyDraft,
  clearReplyDraft,
  clearAllReplyDrafts,
  resolveDraftHydration,
  THREAD_TAIL_EXPANDED,
  threadDisplayPlan,
  collapsedRowMeta,
  MAX_REPLY_ATTACHMENTS,
  MAX_REPLY_ATTACHMENT_TOTAL_BYTES,
  attachmentBudget,
  hasPendingUploads,
  readyAttachmentRefs,
  admitPickedFile,
  composerSendState,
} = await import('./mail-drafts.js')

const emailApi = await import('./email-api.js')

const NOW = 1_756_400_000_000 // fixed epoch so TTL tests are exact
const SCOPE = { userId: 'user-a', mailboxId: 'mb-1', ticketId: 'T-1' }

beforeEach(() => {
  store.clear()
  failWrites = false
  failReads = false
})

/* ─────────────────────────── the key ─────────────────────────── */

describe('replyDraftKey', () => {
  it('is <prefix><userId>.<mailboxId>.<ticketId> — the exact web key shape', () => {
    expect(replyDraftKey(SCOPE)).toBe('un1t.email.reply-draft.user-a.mb-1.T-1')
  })

  it('a missing mailbox uses the "none" sentinel (an orphan ticket still persists, per-user)', () => {
    expect(replyDraftKey({ userId: 'user-a', ticketId: 'T-1' }))
      .toBe('un1t.email.reply-draft.user-a.none.T-1')
  })

  it('FAILS CLOSED: no userId → no key at all', () => {
    expect(replyDraftKey({ mailboxId: 'mb-1', ticketId: 'T-1' })).toBeNull()
  })

  it('fails closed on a missing ticketId too', () => {
    expect(replyDraftKey({ userId: 'user-a', mailboxId: 'mb-1' })).toBeNull()
    expect(replyDraftKey(null)).toBeNull()
  })
})

/* ─────────────────────── write / read / clear ─────────────────────── */

describe('draft round trip', () => {
  it('writes and reads back { text, mode }', async () => {
    expect(await writeReplyDraft(SCOPE, { text: 'Hi Sarah', mode: 'note' }, NOW)).toBe(true)
    expect(await readReplyDraft(SCOPE, NOW)).toEqual({ text: 'Hi Sarah', mode: 'note' })
  })

  it('an unknown stored mode falls back to reply', async () => {
    store.set(replyDraftKey(SCOPE), JSON.stringify({ text: 'x', mode: 'shout', savedAt: NOW }))
    expect(await readReplyDraft(SCOPE, NOW)).toEqual({ text: 'x', mode: 'reply' })
  })

  it('an unknown mode on WRITE is stored as reply, not stored raw', async () => {
    await writeReplyDraft(SCOPE, { text: 'x', mode: 'shout' }, NOW)
    expect(JSON.parse(store.get(replyDraftKey(SCOPE))).mode).toBe('reply')
  })

  it('fail closed: with no userId a write stores NOTHING and a read answers null', async () => {
    const bad = { mailboxId: 'mb-1', ticketId: 'T-1' }
    expect(await writeReplyDraft(bad, { text: 'secret words' }, NOW)).toBe(false)
    expect(store.size).toBe(0)
    expect(await readReplyDraft(bad, NOW)).toBeNull()
  })

  it('EMPTY TEXT IS THE CLEAR PATH: whitespace-only removes an existing draft', async () => {
    await writeReplyDraft(SCOPE, { text: 'real words' }, NOW)
    expect(await writeReplyDraft(SCOPE, { text: '   \n ' }, NOW)).toBe(false)
    expect(store.has(replyDraftKey(SCOPE))).toBe(false)
    expect(await readReplyDraft(SCOPE, NOW)).toBeNull()
  })

  it('caps stored text at REPLY_DRAFT_MAX_LENGTH', async () => {
    await writeReplyDraft(SCOPE, { text: 'a'.repeat(REPLY_DRAFT_MAX_LENGTH + 50) }, NOW)
    const back = await readReplyDraft(SCOPE, NOW)
    expect(back.text.length).toBe(REPLY_DRAFT_MAX_LENGTH)
  })

  it('clearReplyDraft removes exactly this scope’s entry', async () => {
    await writeReplyDraft(SCOPE, { text: 'mine' }, NOW)
    await writeReplyDraft({ ...SCOPE, ticketId: 'T-2' }, { text: 'other ticket' }, NOW)
    await clearReplyDraft(SCOPE)
    expect(await readReplyDraft(SCOPE, NOW)).toBeNull()
    expect(await readReplyDraft({ ...SCOPE, ticketId: 'T-2' }, NOW)).toEqual({ text: 'other ticket', mode: 'reply' })
  })

  it('two users on one device never see each other’s draft for the same ticket', async () => {
    await writeReplyDraft(SCOPE, { text: 'A’s half-written reply' }, NOW)
    expect(await readReplyDraft({ ...SCOPE, userId: 'user-b' }, NOW)).toBeNull()
  })

  it('a storage write failure answers false and never throws', async () => {
    failWrites = true
    expect(await writeReplyDraft(SCOPE, { text: 'doomed' }, NOW)).toBe(false)
  })

  it('a storage read failure answers null and never throws', async () => {
    failReads = true
    expect(await readReplyDraft(SCOPE, NOW)).toBeNull()
  })

  it('corrupt JSON answers null', async () => {
    store.set(replyDraftKey(SCOPE), '{not json')
    expect(await readReplyDraft(SCOPE, NOW)).toBeNull()
  })

  it('a non-string text answers null', async () => {
    store.set(replyDraftKey(SCOPE), JSON.stringify({ text: 42, savedAt: NOW }))
    expect(await readReplyDraft(SCOPE, NOW)).toBeNull()
  })

  it('a stored whitespace-only entry (foreign writer) reads as null — nothing worth restoring', async () => {
    store.set(replyDraftKey(SCOPE), JSON.stringify({ text: '   ', mode: 'reply', savedAt: NOW }))
    expect(await readReplyDraft(SCOPE, NOW)).toBeNull()
  })
})

/* ─────────────────────────── TTL ─────────────────────────── */

describe('TTL (14 days)', () => {
  it('the constants are the web store’s', () => {
    expect(REPLY_DRAFT_TTL_MS).toBe(14 * 24 * 60 * 60 * 1000)
    expect(REPLY_DRAFT_MAX_ENTRIES).toBe(30)
    expect(REPLY_DRAFT_MAX_LENGTH).toBe(10000)
    expect(REPLY_DRAFT_PREFIX).toBe('un1t.email.reply-draft.')
    expect(REPLY_DRAFT_MODES).toEqual(['reply', 'note'])
  })

  it('a draft one tick inside the TTL survives', async () => {
    await writeReplyDraft(SCOPE, { text: 'weekend words' }, NOW)
    expect(await readReplyDraft(SCOPE, NOW + REPLY_DRAFT_TTL_MS)).toEqual({ text: 'weekend words', mode: 'reply' })
  })

  it('a draft past the TTL reads as null AND its key is cleared on the way out', async () => {
    await writeReplyDraft(SCOPE, { text: 'stale' }, NOW)
    expect(await readReplyDraft(SCOPE, NOW + REPLY_DRAFT_TTL_MS + 1)).toBeNull()
    expect(store.has(replyDraftKey(SCOPE))).toBe(false)
  })

  it('an unreadable savedAt is treated as expired — assume the worst, not fine', async () => {
    store.set(replyDraftKey(SCOPE), JSON.stringify({ text: 'no stamp', mode: 'reply' }))
    expect(await readReplyDraft(SCOPE, NOW)).toBeNull()
  })
})

/* ─────────────────────────── eviction ─────────────────────────── */

describe('prune on write', () => {
  it('a write sweeps TTL-expired siblings', async () => {
    await writeReplyDraft({ ...SCOPE, ticketId: 'T-old' }, { text: 'ancient' }, NOW - REPLY_DRAFT_TTL_MS - 1000)
    await writeReplyDraft(SCOPE, { text: 'fresh' }, NOW)
    expect(store.has(replyDraftKey({ ...SCOPE, ticketId: 'T-old' }))).toBe(false)
    expect(store.has(replyDraftKey(SCOPE))).toBe(true)
  })

  it(`the ${'count'} cap evicts the OLDEST once entries exceed REPLY_DRAFT_MAX_ENTRIES`, async () => {
    for (let i = 0; i < REPLY_DRAFT_MAX_ENTRIES + 2; i++) {
      await writeReplyDraft({ ...SCOPE, ticketId: `T-${i}` }, { text: `draft ${i}` }, NOW + i)
    }
    // The two oldest are gone; everything newer survives.
    expect(store.has(replyDraftKey({ ...SCOPE, ticketId: 'T-0' }))).toBe(false)
    expect(store.has(replyDraftKey({ ...SCOPE, ticketId: 'T-1' }))).toBe(false)
    expect(store.has(replyDraftKey({ ...SCOPE, ticketId: 'T-2' }))).toBe(true)
    const draftKeys = [...store.keys()].filter(k => k.startsWith(REPLY_DRAFT_PREFIX))
    expect(draftKeys.length).toBe(REPLY_DRAFT_MAX_ENTRIES)
  })

  it('🔴 the prune only ever touches its own prefix — a stranger’s key survives', async () => {
    store.set('physical_location_snapshot_v1', 'not ours')
    store.set('un1t.mail.density', 'compact')
    await writeReplyDraft({ ...SCOPE, ticketId: 'T-old' }, { text: 'ancient' }, NOW - REPLY_DRAFT_TTL_MS - 1000)
    await writeReplyDraft(SCOPE, { text: 'fresh' }, NOW)
    expect(store.get('physical_location_snapshot_v1')).toBe('not ours')
    expect(store.get('un1t.mail.density')).toBe('compact')
  })

  it('a prune that cannot run leaves the write standing (getAllKeys throwing is not an error the operator sees)', async () => {
    // Write succeeds, then reads fail (prune path). The draft must still land.
    await writeReplyDraft(SCOPE, { text: 'kept' }, NOW)
    expect(store.has(replyDraftKey(SCOPE))).toBe(true)
  })
})

describe('clearAllReplyDrafts', () => {
  it('removes every draft, counts them, and leaves foreign keys alone', async () => {
    await writeReplyDraft(SCOPE, { text: 'one' }, NOW)
    await writeReplyDraft({ ...SCOPE, ticketId: 'T-2' }, { text: 'two' }, NOW)
    store.set('unrelated', 'stays')
    expect(await clearAllReplyDrafts()).toBe(2)
    expect([...store.keys()]).toEqual(['unrelated'])
  })

  it('answers 0 when storage is unavailable rather than throwing', async () => {
    failReads = true
    expect(await clearAllReplyDrafts()).toBe(0)
  })
})

/* ─────────────────── hydration: live typing wins ─────────────────── */

describe('resolveDraftHydration', () => {
  it('🔴 LIVE TYPING OUTRANKS THE STORED DRAFT — hydration must never erase words mid-sentence', () => {
    expect(resolveDraftHydration({ liveText: 'already typ', draft: { text: 'stored', mode: 'note' } }))
      .toEqual({ action: 'keep-live' })
  })

  it('live typing wins even with no stored draft (nothing to hydrate, nothing to clear)', () => {
    expect(resolveDraftHydration({ liveText: 'already typ', draft: null })).toEqual({ action: 'keep-live' })
  })

  it('whitespace-only live text is not typing — the draft hydrates', () => {
    expect(resolveDraftHydration({ liveText: '  \n', draft: { text: 'stored', mode: 'note' } }))
      .toEqual({ action: 'hydrate', text: 'stored', mode: 'note' })
  })

  it('a bad mode on the draft hydrates as reply', () => {
    expect(resolveDraftHydration({ liveText: '', draft: { text: 'stored', mode: 'shout' } }))
      .toEqual({ action: 'hydrate', text: 'stored', mode: 'reply' })
  })

  it('a blank or holey stored draft is not worth hydrating — action none, not an empty restore', () => {
    expect(resolveDraftHydration({ liveText: '', draft: { text: '   ', mode: 'note' } })).toEqual({ action: 'none' })
    expect(resolveDraftHydration({ liveText: '', draft: { mode: 'note' } })).toEqual({ action: 'none' })
  })

  it('nothing live and nothing stored: no action', () => {
    expect(resolveDraftHydration({ liveText: '', draft: null })).toEqual({ action: 'none' })
    expect(resolveDraftHydration({})).toEqual({ action: 'none' })
  })
})

/* ─────────────────────── thread collapse ─────────────────────── */

const msg = (id, over = {}) => ({ id, direction: 'inbound', created_at: '2026-08-27T10:00:00Z', ...over })

describe('threadDisplayPlan', () => {
  it('keeps the newest TWO expanded and collapses everything older', () => {
    expect(THREAD_TAIL_EXPANDED).toBe(2)
    const plan = threadDisplayPlan([msg('a'), msg('b'), msg('c'), msg('d')], new Set())
    expect(plan.map(p => [p.message.id, p.collapsed])).toEqual([
      ['a', true], ['b', true], ['c', false], ['d', false],
    ])
  })

  it('a tapped id expands, without expanding its collapsed neighbours', () => {
    const plan = threadDisplayPlan([msg('a'), msg('b'), msg('c'), msg('d')], new Set(['a']))
    expect(plan.map(p => p.collapsed)).toEqual([false, true, false, false])
  })

  it('two or fewer messages never collapse', () => {
    expect(threadDisplayPlan([msg('a'), msg('b')], new Set()).map(p => p.collapsed)).toEqual([false, false])
    expect(threadDisplayPlan([msg('a')], new Set()).map(p => p.collapsed)).toEqual([false])
    expect(threadDisplayPlan([], new Set())).toEqual([])
    expect(threadDisplayPlan(null, new Set())).toEqual([])
  })

  it('works without an expandedIds set at all', () => {
    expect(threadDisplayPlan([msg('a'), msg('b'), msg('c')]).map(p => p.collapsed)).toEqual([true, false, false])
  })
})

describe('collapsedRowMeta', () => {
  const now = new Date('2026-08-29T12:00:00')

  it('an internal note collapses to its author with the note tone — never mistakable for correspondence', () => {
    const m = msg('n1', { direction: 'outbound', is_internal_note: true, author_name: 'Ciara', created_at: '2026-08-25T09:00:00' })
    expect(collapsedRowMeta(m, { now })).toEqual({ who: 'Ciara', what: 'Internal note', when: '25 Aug', tone: 'note' })
  })

  it('a note with no author still says Staff', () => {
    const m = msg('n1', { direction: 'outbound', is_internal_note: true, created_at: '2026-08-25T09:00:00' })
    expect(collapsedRowMeta(m, { now }).who).toBe('Staff')
  })

  it('an outbound reply says Replied, by name when we have one', () => {
    const m = msg('o1', { direction: 'outbound', author_name: 'Alex', created_at: '2026-08-24T09:00:00' })
    expect(collapsedRowMeta(m, { now })).toEqual({ who: 'Alex', what: 'Replied', when: '24 Aug', tone: 'out' })
    expect(collapsedRowMeta(msg('o2', { direction: 'outbound' }), { now }).who).toBe('You')
  })

  it('inbound rows name the sender; the thread’s first message is called that', () => {
    const m = msg('i1', { from_email: 'sarah@x.com', created_at: '2026-08-12T09:00:00' })
    expect(collapsedRowMeta(m, { isFirst: true, fallbackName: "Sarah O'Brien", now }))
      .toEqual({ who: "Sarah O'Brien", what: 'First message', when: '12 Aug', tone: 'in' })
    expect(collapsedRowMeta(m, { now }).what).toBe('Wrote')
    expect(collapsedRowMeta(msg('i2', { created_at: '2026-08-12T09:00:00' }), { now }).who).toBe('Member')
  })

  it('a same-day message shows its time, zero-padded 24h', () => {
    const m = msg('i1', { created_at: '2026-08-29T09:05:00' })
    expect(collapsedRowMeta(m, { now }).when).toBe('09:05')
  })

  it('an unparseable date shows nothing rather than "Invalid Date"', () => {
    expect(collapsedRowMeta(msg('i1', { created_at: 'garbage' }), { now }).when).toBe('')
  })
})

/* ─────────────── reply attachments + the send gate ─────────────── */

const file = (over = {}) => ({ key: 'k', filename: 'f.pdf', size: 1000, status: 'ready', ref: { draft_id: 'd', index: 0 }, ...over })

describe('attachmentBudget', () => {
  it('the ceiling is 7 MiB of raw bytes — the web outbound rule, restated', () => {
    expect(MAX_REPLY_ATTACHMENT_TOTAL_BYTES).toBe(7 * 1024 * 1024)
    expect(MAX_REPLY_ATTACHMENTS).toBe(10)
  })

  it('🔴 PINNED to email-api’s exported limits — the two files may never disagree about the ceiling', () => {
    expect(MAX_REPLY_ATTACHMENT_TOTAL_BYTES).toBe(emailApi.MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES)
    expect(MAX_REPLY_ATTACHMENTS).toBe(emailApi.MAX_OUTBOUND_ATTACHMENTS)
  })

  it('sums sizes and flags over strictly past the limit', () => {
    const at = attachmentBudget([file({ size: MAX_REPLY_ATTACHMENT_TOTAL_BYTES })])
    expect(at.used).toBe(MAX_REPLY_ATTACHMENT_TOTAL_BYTES)
    expect(at.over).toBe(false)
    expect(attachmentBudget([file({ size: MAX_REPLY_ATTACHMENT_TOTAL_BYTES + 1 })]).over).toBe(true)
  })

  it('an unreadable size counts as nothing rather than NaN-poisoning the total', () => {
    expect(attachmentBudget([file({ size: 'huge' }), file({ size: 500 })]).used).toBe(500)
    expect(attachmentBudget([]).used).toBe(0)
    expect(attachmentBudget(null).used).toBe(0)
  })

  it('🔴 a FAILED file’s bytes do not count — a failed 4 MB must not block a ready 4 MB (mail-compose alignment)', () => {
    const four = 4 * 1024 * 1024
    const at = attachmentBudget([file({ size: four, status: 'failed' }), file({ size: four })])
    expect(at.used).toBe(four)
    expect(at.over).toBe(false)
  })

  it('uploading files still count — their bytes are on their way to the wire', () => {
    expect(attachmentBudget([file({ size: 300, status: 'uploading' }), file({ size: 200 })]).used).toBe(500)
  })
})

describe('hasPendingUploads / readyAttachmentRefs', () => {
  it('pending means something is still UPLOADING — failed is not pending', () => {
    expect(hasPendingUploads([file({ status: 'uploading' })])).toBe(true)
    expect(hasPendingUploads([file(), file({ status: 'failed' })])).toBe(false)
    expect(hasPendingUploads([])).toBe(false)
  })

  it('only ready files contribute refs; a ready file with no ref contributes nothing', () => {
    const ready = file({ ref: { draft_id: 'd', index: 0 } })
    const up = file({ status: 'uploading', ref: null })
    const failed = file({ status: 'failed', ref: null })
    const holey = file({ ref: null })
    expect(readyAttachmentRefs([ready, up, failed, holey])).toEqual([{ draft_id: 'd', index: 0 }])
    expect(readyAttachmentRefs(null)).toEqual([])
    // A retried file can hold a stale ref while it re-uploads or after it
    // failed — STATUS is the gate, not the ref's presence.
    expect(readyAttachmentRefs([file({ status: 'uploading', ref: { draft_id: 'd', index: 1 } })])).toEqual([])
    expect(readyAttachmentRefs([file({ status: 'failed', ref: { draft_id: 'd', index: 2 } })])).toEqual([])
  })
})

describe('admitPickedFile', () => {
  it('admits an ordinary file', () => {
    expect(admitPickedFile([], { name: 'a.pdf', size: 1000 })).toBeNull()
  })

  it('refuses the 11th file, naming the cap', () => {
    const ten = Array.from({ length: MAX_REPLY_ATTACHMENTS }, (_, i) => file({ key: `k${i}`, size: 10 }))
    expect(admitPickedFile(ten, { name: 'a.pdf', size: 10 })).toMatch(String(MAX_REPLY_ATTACHMENTS))
  })

  it('refuses a file that pushes the TOTAL over the ceiling, naming the file — before any upload starts', () => {
    const existing = [file({ size: 6 * 1024 * 1024 })]
    const err = admitPickedFile(existing, { name: 'big.mov', size: 2 * 1024 * 1024 })
    expect(err).toMatch('big.mov')
    // Exactly at the ceiling is still fine.
    expect(admitPickedFile(existing, { name: 'ok.pdf', size: 1024 * 1024 })).toBeNull()
  })

  it('an unreadable size is refused rather than admitted blind', () => {
    expect(admitPickedFile([], { name: 'x.bin', size: NaN })).not.toBeNull()
  })

  it('🔴 an EMPTY file (size 0 or negative) is refused with a friendly sentence — the sign route would 400 it opaquely', () => {
    const zero = admitPickedFile([], { name: 'blank.pdf', size: 0 })
    expect(zero).toMatch('blank.pdf')
    expect(zero).toMatch(/empty/i)
    expect(admitPickedFile([], { name: 'neg.bin', size: -5 })).not.toBeNull()
    // One real byte is still a file.
    expect(admitPickedFile([], { name: 'tiny.txt', size: 1 })).toBeNull()
  })
})

describe('composerSendState', () => {
  const base = { text: 'words', isNote: false, files: [], audienceDisabled: false, sending: false }

  it('the happy path can send', () => {
    expect(composerSendState(base)).toEqual({ canSend: true, reason: null })
  })

  it('no words, no send — whitespace counts as no words', () => {
    expect(composerSendState({ ...base, text: '' }).canSend).toBe(false)
    expect(composerSendState({ ...base, text: '   ' })).toEqual({ canSend: false, reason: 'empty' })
  })

  it('an in-flight send blocks a second one', () => {
    expect(composerSendState({ ...base, sending: true })).toEqual({ canSend: false, reason: 'sending' })
  })

  it('a NOTE with files is blocked — a note is sent to nobody, so files cannot ride on it', () => {
    expect(composerSendState({ ...base, isNote: true, files: [file()] }))
      .toEqual({ canSend: false, reason: 'note_has_files' })
  })

  it('a note ignores the reply audience — no requester address still takes a note', () => {
    expect(composerSendState({ ...base, isNote: true, audienceDisabled: true }))
      .toEqual({ canSend: true, reason: null })
  })

  it('a reply with a dead audience is blocked', () => {
    expect(composerSendState({ ...base, audienceDisabled: true }))
      .toEqual({ canSend: false, reason: 'no_audience' })
  })

  it('a file still uploading blocks send — never quietly send a subset', () => {
    expect(composerSendState({ ...base, files: [file(), file({ status: 'uploading' })] }))
      .toEqual({ canSend: false, reason: 'uploading' })
  })

  it('over the byte ceiling blocks send — the red chip, not a failed send', () => {
    expect(composerSendState({ ...base, files: [file({ size: MAX_REPLY_ATTACHMENT_TOTAL_BYTES + 1 })] }))
      .toEqual({ canSend: false, reason: 'over_budget' })
  })

  it('🔴 a FAILED chip on screen BLOCKS send — the old red-caption-only posture let a reply leave without a file whose chip was still visible', () => {
    expect(composerSendState({ ...base, files: [file(), file({ status: 'failed' })] }))
      .toEqual({ canSend: false, reason: 'blocked_files' })
  })

  it('an oversize chip blocks the same way (compose alignment; the thread refuses oversize at the door, but the gate must not depend on that)', () => {
    expect(composerSendState({ ...base, files: [file({ status: 'oversize' })] }))
      .toEqual({ canSend: false, reason: 'blocked_files' })
  })

  it('an uploading chip outranks a failed one — transient first, same order as compose', () => {
    expect(composerSendState({ ...base, files: [file({ status: 'uploading' }), file({ status: 'failed' })] }))
      .toEqual({ canSend: false, reason: 'uploading' })
  })

  it('a NOTE with only a failed chip is still told about the files, not sent', () => {
    expect(composerSendState({ ...base, isNote: true, files: [file({ status: 'failed' })] }))
      .toEqual({ canSend: false, reason: 'note_has_files' })
  })
})
