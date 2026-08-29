// mobile/lib/mail-forward.test.js — MOBILE-MAIL-FORWARD.1: the decision
// surface behind the forward screen (app/(staff)/email/forward.jsx), tested
// off-screen (contract rule: screens have no render harness, every branchable
// decision lives in a lib).
//
// The rules under test MIRROR the web's src/lib/email-forward.js — mobile
// cannot import src/lib, so each is a deliberate restatement and the tests pin
// the properties that must not drift:
//
//   • canForwardMessage — an INTERNAL NOTE CANNOT BE FORWARDED. A note is
//     staff-to-staff text that was never sent to anybody; mailing it to a
//     third party under the studio's own address is the one worst thing this
//     surface could do. The route 400s it too — this is the affordance, that
//     is the gate.
//   • forwardableAttachments — a row with NO STORED BYTES is never offered:
//     there is nothing to attach, and a checkbox for it would promise a file
//     that cannot be sent. It stays LISTED (unforwardableAttachments) so
//     staff never tell a member "you never sent that".
//   • defaultForwardSelection — everything when everything fits, NOTHING when
//     it does not. A greedy subset would be files the operator did not decide
//     to leave out — the silent drop the whole feature exists to prevent.
//   • forwardSendState — the ONE answer to "is Send live", read by the button
//     and the submit guard so they cannot disagree. An over-budget selection
//     blocks HERE: a refused send the screen could have predicted is a bug.

import { describe, it, expect, vi } from 'vitest'

// mail-forward imports nothing RN-touching, but the limit-pinning test below
// imports email-api, whose RN deps must never load under vitest.
vi.mock('./api', () => ({ api: vi.fn() }))
vi.mock('./supabase', () => ({ supabase: { storage: { from: vi.fn() } } }))
vi.mock('./upload-bytes', () => ({ readFileAsArrayBuffer: vi.fn() }))

const {
  MAX_FORWARD_ATTACHMENT_TOTAL_BYTES,
  FORWARD_PREVIEW_MAX_LINES,
  FORWARD_PREVIEW_MAX_CHARS,
  canForwardMessage,
  newestForwardableMessage,
  forwardSubject,
  forwardPreviewMeta,
  forwardableAttachments,
  unforwardableAttachments,
  forwardBudget,
  defaultForwardSelection,
  toggleForwardSelection,
  selectedForwardRows,
  forwardSendState,
} = await import('./mail-forward.js')

const emailApi = await import('./email-api.js')

/* ───────────────────── which messages may go ───────────────────── */

describe('canForwardMessage', () => {
  it('an ordinary inbound message can be forwarded', () => {
    expect(canForwardMessage({ id: 'm1', direction: 'inbound' })).toBe(true)
  })

  it('an outbound reply can be forwarded too — passing on our own answer is legitimate', () => {
    expect(canForwardMessage({ id: 'm2', direction: 'outbound', is_internal_note: false })).toBe(true)
  })

  it('🔴 an INTERNAL NOTE can never be forwarded — the web rule, verbatim', () => {
    expect(canForwardMessage({ id: 'm3', direction: 'outbound', is_internal_note: true })).toBe(false)
  })

  it('no message, no forward', () => {
    expect(canForwardMessage(null)).toBe(false)
    expect(canForwardMessage(undefined)).toBe(false)
  })
})

describe('newestForwardableMessage', () => {
  const note = { id: 'n', is_internal_note: true }
  const older = { id: 'a', direction: 'inbound' }
  const newer = { id: 'b', direction: 'outbound' }

  it('picks the NEWEST forwardable message (messages arrive oldest-first)', () => {
    expect(newestForwardableMessage([older, newer])).toBe(newer)
  })

  it('skips trailing internal notes — the ⋮ acts on real correspondence, not the note on top', () => {
    expect(newestForwardableMessage([older, newer, note])).toBe(newer)
  })

  it('null when the thread holds nothing forwardable', () => {
    expect(newestForwardableMessage([note])).toBeNull()
    expect(newestForwardableMessage([])).toBeNull()
    expect(newestForwardableMessage(null)).toBeNull()
  })
})

/* ───────────────────── the preview card ───────────────────── */

describe('forwardSubject', () => {
  it('prefixes Fwd: exactly once', () => {
    expect(forwardSubject('Refund')).toBe('Fwd: Refund')
    expect(forwardSubject('Fwd: Refund')).toBe('Fwd: Refund')
    expect(forwardSubject('FW: Refund')).toBe('FW: Refund')
    expect(forwardSubject('fw: Refund')).toBe('fw: Refund')
  })

  it('keeps Re: — "Fwd: Re: Refund" is the truthful description of forwarding a reply', () => {
    expect(forwardSubject('Re: Refund')).toBe('Fwd: Re: Refund')
  })

  it('an empty subject reads as (no subject), still marked as a forward', () => {
    expect(forwardSubject('')).toBe('Fwd: (no subject)')
    expect(forwardSubject('   ')).toBe('Fwd: (no subject)')
    expect(forwardSubject(null)).toBe('Fwd: (no subject)')
  })
})

describe('forwardPreviewMeta', () => {
  // Local-time ISO strings (no Z) — the same convention mail-drafts.test.js
  // uses, so the assertion is TZ-independent.
  const message = {
    id: 'm1',
    from_email: 'sarah@example.com',
    subject: 'Refund for August',
    text_body: 'Hi,\r\nCould I get a refund?\nThanks,\nSarah',
    sent_at: '2026-08-25T09:05:00',
  }

  it('names the sender, the date and the forward subject', () => {
    const meta = forwardPreviewMeta(message)
    expect(meta.from).toBe('sarah@example.com')
    expect(meta.when).toBe('25 Aug 2026, 09:05')
    expect(meta.subject).toBe('Fwd: Refund for August')
  })

  it('quotes the first lines of the text, CRLF-normalised', () => {
    const meta = forwardPreviewMeta(message)
    expect(meta.excerpt).toBe('Hi,\nCould I get a refund?\nThanks,\nSarah')
    expect(meta.excerptTruncated).toBe(false)
  })

  it('caps the excerpt at the line limit and says it was cut', () => {
    const long = { ...message, text_body: Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n') }
    const meta = forwardPreviewMeta(long)
    expect(meta.excerpt.split('\n').length).toBe(FORWARD_PREVIEW_MAX_LINES)
    expect(meta.excerptTruncated).toBe(true)
  })

  it('caps the excerpt at the char limit too — one enormous single line still folds', () => {
    const long = { ...message, text_body: 'x'.repeat(FORWARD_PREVIEW_MAX_CHARS + 100) }
    const meta = forwardPreviewMeta(long)
    expect(meta.excerpt.length).toBe(FORWARD_PREVIEW_MAX_CHARS)
    expect(meta.excerptTruncated).toBe(true)
  })

  it('a message with no text says so rather than rendering blank', () => {
    expect(forwardPreviewMeta({ ...message, text_body: '' }).excerpt).toBe('(no text content)')
    expect(forwardPreviewMeta({ ...message, text_body: '   ' }).excerpt).toBe('(no text content)')
  })

  it('falls back to created_at when sent_at is missing, and shows nothing for garbage — never "Invalid Date"', () => {
    expect(forwardPreviewMeta({ ...message, sent_at: null, created_at: '2026-08-24T10:00:00' }).when)
      .toBe('24 Aug 2026, 10:00')
    expect(forwardPreviewMeta({ ...message, sent_at: 'garbage' }).when).toBe('')
    expect(forwardPreviewMeta(null).when).toBe('')
  })

  it('an unknown sender is said in words', () => {
    expect(forwardPreviewMeta({ ...message, from_email: null }).from).toBe('Unknown sender')
  })
})

/* ───────────────────── which files may ride ───────────────────── */

const att = (id, over = {}) => ({
  id, filename: `${id}.pdf`, size_bytes: 1000, mime_type: 'application/pdf', stored: true, ...over,
})

describe('forwardableAttachments / unforwardableAttachments', () => {
  it('offers only rows with stored bytes; a SKIPPED row is listed on the other side with its reason intact', () => {
    const rows = [att('a'), att('b', { stored: false, skipped_reason: 'over_quota' }), att('c')]
    expect(forwardableAttachments(rows).map(r => r.id)).toEqual(['a', 'c'])
    const skipped = unforwardableAttachments(rows)
    expect(skipped.map(r => r.id)).toEqual(['b'])
    expect(skipped[0].skipped_reason).toBe('over_quota')
  })

  it('accepts the server-row shape too (storage_path instead of stored) — same fact, either vocabulary', () => {
    expect(forwardableAttachments([{ id: 'x', storage_path: 'p' }]).length).toBe(1)
  })

  it('empty and null are empty', () => {
    expect(forwardableAttachments(null)).toEqual([])
    expect(forwardableAttachments([])).toEqual([])
    expect(unforwardableAttachments(null)).toEqual([])
  })
})

describe('forwardBudget', () => {
  it('🔴 the ceiling is PINNED to email-api’s exported limit — two files may never disagree about it', () => {
    expect(MAX_FORWARD_ATTACHMENT_TOTAL_BYTES).toBe(emailApi.MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES)
    expect(MAX_FORWARD_ATTACHMENT_TOTAL_BYTES).toBe(7 * 1024 * 1024)
  })

  it('sums size_bytes and flags over strictly past the ceiling', () => {
    const exactly = forwardBudget([att('a', { size_bytes: MAX_FORWARD_ATTACHMENT_TOTAL_BYTES })])
    expect(exactly.used).toBe(MAX_FORWARD_ATTACHMENT_TOTAL_BYTES)
    expect(exactly.over).toBe(false)
    expect(exactly.limit).toBe(MAX_FORWARD_ATTACHMENT_TOTAL_BYTES)
    expect(forwardBudget([att('a', { size_bytes: MAX_FORWARD_ATTACHMENT_TOTAL_BYTES + 1 })]).over).toBe(true)
  })

  it('an unreadable size counts as nothing rather than NaN-poisoning the total', () => {
    expect(forwardBudget([att('a', { size_bytes: 'big' }), att('b', { size_bytes: 500 })]).used).toBe(500)
    expect(forwardBudget([]).used).toBe(0)
    expect(forwardBudget(null).used).toBe(0)
  })
})

describe('defaultForwardSelection', () => {
  it('pre-ticks EVERYTHING when the whole stored set fits', () => {
    expect(defaultForwardSelection([att('a'), att('b')])).toEqual(['a', 'b'])
  })

  it('🔴 pre-ticks NOTHING when the set does not fit — a greedy subset is a silent drop', () => {
    const rows = [
      att('a', { size_bytes: 4 * 1024 * 1024 }),
      att('b', { size_bytes: 4 * 1024 * 1024 }),
    ]
    expect(defaultForwardSelection(rows)).toEqual([])
  })

  it('no files, no selection', () => {
    expect(defaultForwardSelection([])).toEqual([])
    expect(defaultForwardSelection(null)).toEqual([])
  })
})

describe('toggleForwardSelection / selectedForwardRows', () => {
  it('toggles an id in and out', () => {
    expect(toggleForwardSelection(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleForwardSelection(['a', 'b'], 'a')).toEqual(['b'])
    expect(toggleForwardSelection(null, 'a')).toEqual(['a'])
  })

  it('resolves selected ids to rows in the ORIGINAL order — the forward’s chips read the same way round', () => {
    const rows = [att('a'), att('b'), att('c')]
    expect(selectedForwardRows(rows, ['c', 'a']).map(r => r.id)).toEqual(['a', 'c'])
    expect(selectedForwardRows(rows, []).length).toBe(0)
    expect(selectedForwardRows(null, ['a'])).toEqual([])
  })
})

/* ───────────────────── the send gate ───────────────────── */

describe('forwardSendState', () => {
  const pill = { address: 'x@y.com' }

  it('one To pill with a fitting selection can send — the note is OPTIONAL', () => {
    expect(forwardSendState({ pills: [pill], selectedRows: [att('a')] }))
      .toEqual({ canSend: true, reason: null })
    expect(forwardSendState({ pills: [pill], selectedRows: [] }).canSend).toBe(true)
  })

  it('no recipient, no send — a forward’s audience is entirely the operator’s choice', () => {
    const state = forwardSendState({ pills: [], selectedRows: [] })
    expect(state.canSend).toBe(false)
    expect(state.reason).toBe('Add at least one recipient.')
    expect(forwardSendState({}).canSend).toBe(false)
  })

  it('🔴 an over-budget selection blocks send BEFORE the wire — a refused send the screen could have predicted is a bug', () => {
    const rows = [att('a', { size_bytes: MAX_FORWARD_ATTACHMENT_TOTAL_BYTES + 1 })]
    const state = forwardSendState({ pills: [pill], selectedRows: rows })
    expect(state.canSend).toBe(false)
    // The sentence names both numbers (formatAttachmentSize renders the
    // 7 MiB ceiling as "7.0 MB") and the remedy.
    expect(state.reason).toMatch('7.0 MB')
    expect(state.reason).toMatch(/untick/i)
  })

  it('exactly at the ceiling still sends', () => {
    const rows = [att('a', { size_bytes: MAX_FORWARD_ATTACHMENT_TOTAL_BYTES })]
    expect(forwardSendState({ pills: [pill], selectedRows: rows }).canSend).toBe(true)
  })

  it('the missing-recipient reason outranks the budget one — fix who first, then what', () => {
    const rows = [att('a', { size_bytes: MAX_FORWARD_ATTACHMENT_TOTAL_BYTES + 1 })]
    expect(forwardSendState({ pills: [], selectedRows: rows }).reason).toBe('Add at least one recipient.')
  })
})
