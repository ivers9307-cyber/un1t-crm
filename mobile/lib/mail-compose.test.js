// MOBILE-MAIL-COMPOSE.1 — the decisions behind the compose sheet (mockup §05),
// kept out of the screen so they can be tested and mutation-tested here.
// Recipient pill state, validation, and attachment size maths all live in
// ./mail-compose; app/(staff)/email/compose.jsx only renders what these
// functions decide.
//
// Pure module — no ./api mock needed (nothing here touches the wire; the
// screen calls composeEmail/signOutboundAttachment itself).

import { describe, it, expect } from 'vitest'

import {
  normalizeAddress,
  addRecipients,
  addContactPill,
  removePill,
  popPill,
  pillInitials,
  contactTag,
  filterContactSuggestions,
  shouldSearchContacts,
  classifyPickedFiles,
  attachmentBudget,
  hasPendingUploads,
  hasBlockedAttachments,
  readyAttachmentRefs,
  composeSendState,
  sendFailureMessage,
  defaultMailboxId,
  mailboxDisplay,
  composeIsDirty,
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_ATTACHMENTS,
} from './mail-compose'

// ── normalizeAddress ─────────────────────────────────────────────────

describe('normalizeAddress', () => {
  it('lowercases and trims a plain address', () => {
    expect(normalizeAddress('  Sarah.OBrien@Gmail.COM ')).toBe('sarah.obrien@gmail.com')
  })

  it('accepts the "Display Name <addr>" form operators paste from a mail client', () => {
    expect(normalizeAddress('Sarah O\'Brien <sarah@x.com>')).toBe('sarah@x.com')
  })

  it.each([
    ['not-an-address', 'no @ at all'],
    ['a@b', 'no TLD'],
    ['', 'empty'],
    ['   ', 'whitespace'],
    ['a b@x.com', 'space in local part'],
  ])('rejects %s (%s)', (raw) => {
    expect(normalizeAddress(raw)).toBeNull()
  })

  it('rejects non-strings rather than coercing', () => {
    expect(normalizeAddress(null)).toBeNull()
    expect(normalizeAddress(42)).toBeNull()
    expect(normalizeAddress(['a@x.com'])).toBeNull()
  })
})

// ── recipient pills ──────────────────────────────────────────────────

describe('addRecipients', () => {
  it('turns free-typed text into a pill with no name and no tag', () => {
    const { pills, invalid } = addRecipients([], 'supplier@acme.ie')
    expect(pills).toEqual([{ address: 'supplier@acme.ie', name: null, tag: null }])
    expect(invalid).toEqual([])
  })

  it('splits a paste on commas, semicolons and whitespace', () => {
    const { pills } = addRecipients([], 'a@x.com, b@x.com; c@x.com\nd@x.com')
    expect(pills.map(p => p.address)).toEqual(['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com'])
  })

  it('dedupes case-insensitively against existing pills AND within the paste', () => {
    const first = addRecipients([], 'a@x.com').pills
    const { pills } = addRecipients(first, 'A@X.COM b@x.com B@x.com')
    expect(pills.map(p => p.address)).toEqual(['a@x.com', 'b@x.com'])
  })

  it('reports invalid tokens instead of silently dropping them', () => {
    const { pills, invalid } = addRecipients([], 'good@x.com nonsense')
    expect(pills.map(p => p.address)).toEqual(['good@x.com'])
    expect(invalid).toEqual(['nonsense'])
  })

  it('is a no-op on empty input', () => {
    const existing = addRecipients([], 'a@x.com').pills
    const { pills, invalid } = addRecipients(existing, '   ')
    expect(pills).toBe(existing)
    expect(invalid).toEqual([])
  })
})

describe('addContactPill', () => {
  const member = { id: 'c1', name: 'Niamh Doyle', email: 'Niamh.Doyle@Gmail.com', pipeline_stage_slug: 'member' }

  it('pills the contact with their name and a MEMBER/LEAD tag, address normalised', () => {
    const { pills } = addContactPill([], member)
    expect(pills).toEqual([{
      address: 'niamh.doyle@gmail.com',
      name: 'Niamh Doyle',
      tag: 'member',
    }])
  })

  it('refuses a contact with no usable email — a pill that cannot send is a lie', () => {
    const { pills, error } = addContactPill([], { id: 'c2', name: 'No Email' })
    expect(pills).toEqual([])
    expect(error).toMatch(/email/i)
  })

  it('does not add the same address twice (case-insensitively, vs a free-typed pill)', () => {
    const typed = addRecipients([], 'niamh.doyle@gmail.com').pills
    const { pills } = addContactPill(typed, member)
    expect(pills).toHaveLength(1)
  })
})

describe('removePill / popPill', () => {
  const three = addRecipients([], 'a@x.com b@x.com c@x.com').pills

  it('removePill removes by address', () => {
    expect(removePill(three, 'b@x.com').map(p => p.address)).toEqual(['a@x.com', 'c@x.com'])
  })

  it('popPill removes the LAST pill (the backspace-on-empty-input gesture)', () => {
    const { pills, removed } = popPill(three)
    expect(removed.address).toBe('c@x.com')
    expect(pills.map(p => p.address)).toEqual(['a@x.com', 'b@x.com'])
  })

  it('popPill on nothing is a no-op, not a crash', () => {
    const { pills, removed } = popPill([])
    expect(pills).toEqual([])
    expect(removed).toBeNull()
  })
})

describe('pillInitials', () => {
  it('two initials from a two-word name', () => {
    expect(pillInitials("Sarah O'Brien")).toBe('SO')
  })
  it('one initial from a single name', () => {
    expect(pillInitials('Cher')).toBe('C')
  })
  it('falls back to the local part of an address', () => {
    expect(pillInitials(null, 'niamh.doyle@gmail.com')).toBe('N')
  })
  it('never returns an empty string — the mono circle must not render blank', () => {
    expect(pillInitials(null, null)).toBe('?')
  })
})

// ── suggestion tagging + filtering ───────────────────────────────────

describe('contactTag', () => {
  it.each(['member', 'converted', 'pack_member', 'returning_converted'])(
    '%s is a MEMBER', (slug) => {
      expect(contactTag({ pipeline_stage_slug: slug })).toBe('member')
    })

  it.each(['new_lead', 'first_class', 'cold_lead', 'dormant', null, undefined])(
    '%s is a LEAD', (slug) => {
      expect(contactTag({ pipeline_stage_slug: slug })).toBe('lead')
    })
})

describe('filterContactSuggestions', () => {
  const contacts = [
    { id: '1', name: 'Niamh Doyle', email: 'niamh@x.com', pipeline_stage_slug: 'member' },
    { id: '2', name: 'No Email', email: null },
    { id: '3', name: 'Nick Kearns', email: 'nick@x.com', pipeline_stage_slug: 'new_lead' },
    { id: '4', name: 'Bad Email', email: 'not-an-address' },
  ]

  it('drops contacts without a sendable address, keeps the rest in order', () => {
    const out = filterContactSuggestions(contacts, { pills: [] })
    expect(out.map(c => c.id)).toEqual(['1', '3'])
  })

  it('drops contacts already pilled — suggesting someone twice invites a double-add', () => {
    const pills = addRecipients([], 'NIAMH@X.COM').pills
    const out = filterContactSuggestions(contacts, { pills })
    expect(out.map(c => c.id)).toEqual(['3'])
  })

  it('caps the list', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: String(i), email: `p${i}@x.com` }))
    expect(filterContactSuggestions(many, { pills: [], limit: 6 })).toHaveLength(6)
  })
})

describe('shouldSearchContacts', () => {
  it('waits for two typed characters — one letter matches half the directory', () => {
    expect(shouldSearchContacts('n')).toBe(false)
    expect(shouldSearchContacts('ni')).toBe(true)
    expect(shouldSearchContacts('  n ')).toBe(false)
  })
})

// ── attachment maths ─────────────────────────────────────────────────

const MB = 1024 * 1024

describe('classifyPickedFiles', () => {
  it('a normal file enters as uploading, with a monotonic key and a mime fallback', () => {
    const { entries, nextIndex, error } = classifyPickedFiles([], [
      { uri: 'file:///a.pdf', name: 'a.pdf', size: 100, mimeType: null },
    ], 0)
    expect(error).toBeNull()
    expect(nextIndex).toBe(1)
    expect(entries).toEqual([{
      key: 'att-0',
      uri: 'file:///a.pdf',
      filename: 'a.pdf',
      mime: 'application/octet-stream',
      size: 100,
      status: 'uploading',
      error: null,
      ref: null,
    }])
  })

  it('a file that would push the total past 7 MiB becomes a RED CHIP (oversize), not a refusal', () => {
    const existing = [{ key: 'att-0', filename: 'big.pdf', mime: 'application/pdf', size: 6 * MB, status: 'ready', error: null, ref: {} }]
    const { entries } = classifyPickedFiles(existing, [
      { uri: 'u', name: 'more.pdf', size: 2 * MB, mimeType: 'application/pdf' },
    ], 1)
    expect(entries[0].status).toBe('oversize')
    expect(entries[0].error).toMatch(/7\.0 MB/)
    expect(entries[0].error).toMatch(/more\.pdf/)
  })

  it('an oversize chip does not spend the budget — a later small file still uploads', () => {
    const { entries: first, nextIndex } = classifyPickedFiles([], [
      { uri: 'u1', name: 'huge.mov', size: 20 * MB, mimeType: 'video/quicktime' },
    ], 0)
    expect(first[0].status).toBe('oversize')
    const { entries: second } = classifyPickedFiles(first, [
      { uri: 'u2', name: 'small.pdf', size: 1 * MB, mimeType: 'application/pdf' },
    ], nextIndex)
    expect(second[0].status).toBe('uploading')
  })

  it('…even inside ONE picked batch — the huge file must not spend the budget the small one needs', () => {
    const { entries } = classifyPickedFiles([], [
      { uri: 'u1', name: 'huge.mov', size: 20 * MB, mimeType: 'video/quicktime' },
      { uri: 'u2', name: 'small.pdf', size: 1 * MB, mimeType: 'application/pdf' },
    ], 0)
    expect(entries.map(e => e.status)).toEqual(['oversize', 'uploading'])
  })

  it('refuses files past the 10-file cap and says so', () => {
    const ten = Array.from({ length: MAX_ATTACHMENTS }, (_, i) => (
      { key: `att-${i}`, filename: `f${i}`, mime: 'x', size: 1, status: 'ready', error: null, ref: {} }
    ))
    const { entries, error } = classifyPickedFiles(ten, [{ uri: 'u', name: 'extra.pdf', size: 1 }], 10)
    expect(entries).toEqual([])
    expect(error).toMatch(/10 files/)
  })

  it('an unreadable size counts as oversize, never as free', () => {
    const { entries } = classifyPickedFiles([], [{ uri: 'u', name: 'mystery.bin', size: undefined }], 0)
    expect(entries[0].status).toBe('oversize')
  })
})

describe('attachmentBudget', () => {
  it('sums only files that could still send (uploading + ready)', () => {
    const files = [
      { size: 100, status: 'ready' },
      { size: 50, status: 'uploading' },
      { size: 9999, status: 'oversize' },
      { size: 77, status: 'failed' },
    ]
    const b = attachmentBudget(files)
    expect(b.used).toBe(150)
    expect(b.limit).toBe(MAX_ATTACHMENT_TOTAL_BYTES)
    expect(b.over).toBe(false)
  })
})

describe('attachment predicates', () => {
  const files = [
    { status: 'ready', ref: { draft_id: 'd', index: 0, filename: 'a', mime: 'x' } },
    { status: 'uploading', ref: null },
    { status: 'failed', ref: null },
    { status: 'oversize', ref: null },
  ]

  it('hasPendingUploads sees only uploading', () => {
    expect(hasPendingUploads(files)).toBe(true)
    expect(hasPendingUploads(files.filter(f => f.status !== 'uploading'))).toBe(false)
  })

  it('hasBlockedAttachments sees failed and oversize', () => {
    expect(hasBlockedAttachments(files)).toBe(true)
    expect(hasBlockedAttachments([{ status: 'ready' }, { status: 'uploading' }])).toBe(false)
  })

  it('readyAttachmentRefs returns ONLY ready refs — a subset send must be impossible', () => {
    expect(readyAttachmentRefs(files)).toEqual([{ draft_id: 'd', index: 0, filename: 'a', mime: 'x' }])
    expect(readyAttachmentRefs([])).toEqual([])
  })
})

// ── send validation ──────────────────────────────────────────────────

describe('composeSendState', () => {
  const good = {
    mailboxId: 'mb-1',
    pills: [{ address: 'a@x.com', name: null, tag: null }],
    subject: 'Hello',
    text: 'Body',
    files: [],
  }

  it('everything present → can send', () => {
    expect(composeSendState(good)).toEqual({ canSend: true, reason: null })
  })

  it.each([
    ['mailboxId', { mailboxId: null }, /account/i],
    ['recipient', { pills: [] }, /recipient/i],
    ['subject', { subject: '   ' }, /subject/i],
    ['body', { text: '' }, /write/i],
  ])('missing %s blocks the send', (_label, patch, reason) => {
    const out = composeSendState({ ...good, ...patch })
    expect(out.canSend).toBe(false)
    expect(out.reason).toMatch(reason)
  })

  it('a file still uploading blocks the send — references to objects not in the bucket yet', () => {
    const out = composeSendState({ ...good, files: [{ status: 'uploading', size: 1 }] })
    expect(out.canSend).toBe(false)
    expect(out.reason).toMatch(/upload/i)
  })

  it('a failed or oversize chip blocks the send — never quietly send a subset of what is on screen', () => {
    const out = composeSendState({ ...good, files: [{ status: 'oversize', size: 1 }] })
    expect(out.canSend).toBe(false)
    expect(out.reason).toMatch(/remove/i)
  })
})

// ── refusal surfacing ────────────────────────────────────────────────

describe('sendFailureMessage', () => {
  it('prefers the Zod issues — "Invalid request body" alone names no field', () => {
    expect(sendFailureMessage({
      success: false,
      error: 'Invalid request body',
      issues: [{ message: 'to: Invalid email' }, { message: 'subject: Required' }],
    })).toBe('to: Invalid email; subject: Required')
  })

  it('falls back to the route error (the 25-recipient cap, dedupe refusals, etc. arrive here)', () => {
    expect(sendFailureMessage({ success: false, error: 'Too many recipients — 30 addresses across To, Cc and Bcc. The limit is 25.' }))
      .toMatch(/Too many recipients/)
  })

  it('has a last-resort sentence', () => {
    expect(sendFailureMessage(null)).toMatch(/Could not send/i)
  })
})

// ── mailbox picker ───────────────────────────────────────────────────

describe('defaultMailboxId', () => {
  const boxes = [
    { id: 'a', address: 'a@x.com' },
    { id: 'b', address: 'b@x.com', is_default: true },
  ]

  it('honours an explicit initial id that exists', () => {
    expect(defaultMailboxId(boxes, 'a')).toBe('a')
  })
  it('ignores an initial id that is not in the visible set', () => {
    expect(defaultMailboxId(boxes, 'zz')).toBe('b')
  })
  it('prefers is_default, then the first, then null', () => {
    expect(defaultMailboxId(boxes)).toBe('b')
    expect(defaultMailboxId([{ id: 'a' }])).toBe('a')
    expect(defaultMailboxId([])).toBeNull()
  })
})

describe('mailboxDisplay', () => {
  it('the ADDRESS is what compose shows — which address a member hears from is the decision', () => {
    expect(mailboxDisplay({ address: 'accounts@x.com', label: 'Accounts' })).toBe('accounts@x.com')
    expect(mailboxDisplay({ label: 'Accounts' })).toBe('Accounts')
    expect(mailboxDisplay(null)).toBe('Mailbox')
  })
})

// ── dirty state ──────────────────────────────────────────────────────

describe('composeIsDirty', () => {
  it('pristine sheet closes silently', () => {
    expect(composeIsDirty({ pills: [], pending: '', subject: '', text: '', files: [] })).toBe(false)
  })

  it.each([
    ['a pill', { pills: [{ address: 'a@x.com' }] }],
    ['half-typed recipient text', { pending: 'ni' }],
    ['a subject', { subject: 'x' }],
    ['body text', { text: 'x' }],
    ['a chosen file', { files: [{ status: 'ready' }] }],
  ])('%s makes it dirty', (_label, patch) => {
    const base = { pills: [], pending: '', subject: '', text: '', files: [] }
    expect(composeIsDirty({ ...base, ...patch })).toBe(true)
  })

  it('whitespace-only subject/body is still pristine', () => {
    expect(composeIsDirty({ pills: [], pending: '  ', subject: ' ', text: '\n', files: [] })).toBe(false)
  })
})
