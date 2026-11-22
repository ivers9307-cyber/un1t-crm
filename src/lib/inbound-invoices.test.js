// INVOICES.1 — pure-helper coverage for inbound_invoices flow.
//
// Address parsing matters most (single bug = lost invoices), so
// give it the deepest case list: case folding, +tag stripping,
// Postmark's "ToFull" array shape, display-name wrappers, and the
// obvious negatives (wrong domain, bad slug shape).

import { describe, it, expect } from 'vitest'
import { WEB_PERMISSIONS } from 'shared/permissions'
import {
  parseInboundAddress,
  INBOUND_INVOICE_SUPPORTED_MIME,
  INBOUND_INVOICE_STATUSES,
  INBOUND_INVOICE_TRANSITIONS,
  canTransitionInboundInvoice,
  inboundInvoiceStoragePath,
  safeInboundFilename,
  classifyInboundAttachments,
  INLINE_IMAGE_SKIP_MAX_BYTES,
  inboundBodyText,
  attachmentMessageId,
  sha256Hex,
} from './inbound-invoices.js'

describe('parseInboundAddress', () => {
  it('extracts slug from a plain string recipient', () => {
    expect(parseInboundAddress('dublin-city-invoices@mail.un1tdublin.com')).toBe('dublin-city')
  })

  it('case-folds the local part and domain', () => {
    expect(parseInboundAddress('DUBLIN-CITY-Invoices@MAIL.UN1Tdublin.COM')).toBe('dublin-city')
  })

  it('strips display name from "Name <addr>" format', () => {
    expect(parseInboundAddress('Vendor Co <accounts-invoices@mail.un1tdublin.com>')).toBe('accounts')
  })

  it('strips Postmark +tag suffix', () => {
    expect(parseInboundAddress('dublin-invoices+x@mail.un1tdublin.com')).toBe('dublin')
  })

  it('accepts the Postmark ToFull array shape', () => {
    const toFull = [
      { Email: 'other@example.com', Name: 'Other' },
      { Email: 'foo-invoices@mail.un1tdublin.com', Name: 'Foo Address' },
    ]
    expect(parseInboundAddress(toFull)).toBe('foo')
  })

  it('handles the OriginalRecipient single-string form (Postmark spec)', () => {
    // Per Postmark docs OriginalRecipient is a plain string with
    // the envelope RCPT TO. The same parser handles it because we
    // accept either string or { Email } objects.
    expect(parseInboundAddress('dublin-invoices@mail.un1tdublin.com')).toBe('dublin')
  })

  it('handles plus-addressing on the slug local part', () => {
    // Postmark uses MailboxHash for the +-suffix. Our parser
    // strips it from the local part so the slug still matches.
    expect(parseInboundAddress('dublin-invoices+ref-123@mail.un1tdublin.com')).toBe('dublin')
  })

  it('returns null on a wrong domain', () => {
    expect(parseInboundAddress('dublin-invoices@example.com')).toBeNull()
  })

  it('returns null on a slug that fails the regex', () => {
    // Starts with a hyphen — DB CHECK would reject this too.
    expect(parseInboundAddress('-bad-invoices@mail.un1tdublin.com')).toBeNull()
  })

  it('returns null when the local part is not the *-invoices form', () => {
    expect(parseInboundAddress('hello@mail.un1tdublin.com')).toBeNull()
  })

  it('returns null on garbage input', () => {
    expect(parseInboundAddress(null)).toBeNull()
    expect(parseInboundAddress(undefined)).toBeNull()
    expect(parseInboundAddress('')).toBeNull()
    expect(parseInboundAddress(42)).toBeNull()
  })
})

describe('INBOUND_INVOICE_SUPPORTED_MIME', () => {
  it('matches the set advertised by invoice-extraction.js', () => {
    // The webhook + the OCR helper both gate on supported types; if
    // these drift, the route accepts files Claude can't read.
    expect(INBOUND_INVOICE_SUPPORTED_MIME.has('application/pdf')).toBe(true)
    expect(INBOUND_INVOICE_SUPPORTED_MIME.has('image/jpeg')).toBe(true)
    expect(INBOUND_INVOICE_SUPPORTED_MIME.has('image/png')).toBe(true)
    expect(INBOUND_INVOICE_SUPPORTED_MIME.has('image/gif')).toBe(true)
    expect(INBOUND_INVOICE_SUPPORTED_MIME.has('image/webp')).toBe(true)
    expect(INBOUND_INVOICE_SUPPORTED_MIME.has('application/msword')).toBe(false)
    expect(INBOUND_INVOICE_SUPPORTED_MIME.has('image/heic')).toBe(false)
  })
})

describe('INBOUND_INVOICE_STATUSES', () => {
  it('matches the DB CHECK enum', () => {
    expect(INBOUND_INVOICE_STATUSES).toEqual([
      'received',
      'quality_approved',
      'extracted',
      'data_approved',
      'forwarded',
      'rejected',
    ])
  })
})

describe('canTransitionInboundInvoice', () => {
  it('allows the happy path', () => {
    expect(canTransitionInboundInvoice('received', 'quality_approved')).toBe(true)
    expect(canTransitionInboundInvoice('quality_approved', 'extracted')).toBe(true)
    expect(canTransitionInboundInvoice('extracted', 'data_approved')).toBe(true)
    expect(canTransitionInboundInvoice('data_approved', 'forwarded')).toBe(true)
  })

  it('allows reject from each non-terminal state', () => {
    expect(canTransitionInboundInvoice('received', 'rejected')).toBe(true)
    expect(canTransitionInboundInvoice('quality_approved', 'rejected')).toBe(true)
    expect(canTransitionInboundInvoice('extracted', 'rejected')).toBe(true)
    expect(canTransitionInboundInvoice('data_approved', 'rejected')).toBe(true)
  })

  it('treats terminal states as absorbing', () => {
    expect(canTransitionInboundInvoice('forwarded', 'rejected')).toBe(false)
    expect(canTransitionInboundInvoice('forwarded', 'data_approved')).toBe(false)
    expect(canTransitionInboundInvoice('rejected', 'received')).toBe(false)
  })

  it('blocks skipping a stage', () => {
    expect(canTransitionInboundInvoice('received', 'extracted')).toBe(false)
    expect(canTransitionInboundInvoice('received', 'data_approved')).toBe(false)
    expect(canTransitionInboundInvoice('quality_approved', 'data_approved')).toBe(false)
  })

  it('rejects unknown states', () => {
    expect(canTransitionInboundInvoice('bogus', 'received')).toBe(false)
    expect(canTransitionInboundInvoice('received', 'bogus')).toBe(false)
  })

  it('keeps the transitions map self-consistent', () => {
    // Every value list references only known states.
    for (const [from, tos] of Object.entries(INBOUND_INVOICE_TRANSITIONS)) {
      expect(INBOUND_INVOICE_STATUSES).toContain(from)
      for (const to of tos) expect(INBOUND_INVOICE_STATUSES).toContain(to)
    }
  })
})

describe('inboundInvoiceStoragePath', () => {
  it('partitions by location and invoice', () => {
    expect(inboundInvoiceStoragePath({
      locationId: 'loc-1', invoiceId: 'inv-9', safeFilename: 'invoice.pdf',
    })).toBe('loc-1/inv-9/invoice.pdf')
  })

  it('throws on missing required parts', () => {
    expect(() => inboundInvoiceStoragePath({ locationId: 'l', invoiceId: 'i', safeFilename: '' }))
      .toThrow()
    expect(() => inboundInvoiceStoragePath({ locationId: 'l', invoiceId: '', safeFilename: 'f' }))
      .toThrow()
    expect(() => inboundInvoiceStoragePath({ locationId: '', invoiceId: 'i', safeFilename: 'f' }))
      .toThrow()
  })
})

describe('safeInboundFilename', () => {
  it('strips path separators', () => {
    expect(safeInboundFilename('../../etc/passwd')).toBe('.._.._etc_passwd')
  })

  it('strips control characters', () => {
    expect(safeInboundFilename('inv\x00oice.pdf')).toBe('invoice.pdf')
  })

  it('returns null for empty / non-string input', () => {
    expect(safeInboundFilename('')).toBeNull()
    expect(safeInboundFilename('   ')).toBeNull()
    expect(safeInboundFilename(null)).toBeNull()
    expect(safeInboundFilename(undefined)).toBeNull()
    expect(safeInboundFilename(42)).toBeNull()
  })

  it('truncates to 200 chars so it fits the DB CHECK on filename', () => {
    const long = 'a'.repeat(400)
    const result = safeInboundFilename(long)
    expect(result.length).toBe(200)
  })
})

// AUDIT-13.E — the staff-facing hint must name an address this parser
// actually accepts.
//
// shared/permissions.js told operators to forward supplier invoices to
// <slug>-invoices@un1tdublin.com. The apex keeps its OWN MX records (the
// marketing mailbox) and only mail.un1tdublin.com is delegated to
// Postmark's inbound infra — see the DOMAIN constant's comment — so mail
// to the hinted address landed in the marketing mailbox and never reached
// this parser. Other UI (LocationForm, InvoicesInbox) already showed the
// mail. subdomain, which is how the drift went unnoticed.
//
// Asserted by round-trip rather than string equality: the hint is fed to
// the real parser, so the two can never drift apart again regardless of
// how either is worded.
describe('the permission hint names the address the parser accepts', () => {
  const hint = WEB_PERMISSIONS.find((p) => p.key === 'invoices_inbox')?.hint || ''

  it('the hint quotes an address', () => {
    expect(hint).toMatch(/<slug>-invoices@\S+/)
  })

  it('that address, with a real slug, parses back to the slug', () => {
    const quoted = hint.match(/<slug>-invoices@([a-z0-9.-]*[a-z0-9])/i)?.[0]
    const address = quoted.replace('<slug>', 'stillorgan')
    expect(
      parseInboundAddress(address),
      `the hint sends operators to ${address}, which this parser rejects`,
    ).toBe('stillorgan')
  })

  it('control — the apex (no mail. subdomain) is still rejected', () => {
    expect(parseInboundAddress('stillorgan-invoices@un1tdublin.com')).toBeNull()
  })
})

const PDF_B64 = Buffer.from('%PDF-1.4 x').toString('base64')
const PNG_B64 = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(8),
]).toString('base64')
const pdf = (over = {}) => ({ Name: 'a.pdf', ContentType: 'application/pdf', Content: PDF_B64, ...over })
const logo = (over = {}) => ({ Name: 'logo.png', ContentType: 'image/png', Content: PNG_B64, ContentID: 'cid1', ...over })
const html = '<p>See attached</p><img src="cid:cid1">'

describe('classifyInboundAttachments', () => {
  it('skips an inline image when the email also has a real attachment', () => {
    const r = classifyInboundAttachments([pdf(), logo()], html)
    expect(r.usable.map((a) => a.name)).toEqual(['a.pdf'])
    expect(r.skippedInline).toBe(1)
  })
  it('keeps inline images when nothing else is usable (a phone photo of a receipt)', () => {
    const r = classifyInboundAttachments([logo({ Name: 'IMG_1.png' })], html)
    expect(r.usable).toHaveLength(1)
    expect(r.skippedInline).toBe(0)
  })
  it('does not treat an image as inline when the body never references its ContentID', () => {
    expect(classifyInboundAttachments([pdf(), logo()], '<p>hi</p>').usable).toHaveLength(2)
  })
  it('matches a ContentID wrapped in angle brackets, ignoring case', () => {
    const r = classifyInboundAttachments([pdf(), logo({ ContentID: '<CID1>' })], html)
    expect(r.skippedInline).toBe(1)
  })
  it('judges a mislabelled PDF by its bytes', () => {
    const r = classifyInboundAttachments([pdf({ ContentType: 'application/octet-stream' })], '')
    expect(r.usable[0].mime).toBe('application/pdf')
  })
  it('reports unsupported types and empty content', () => {
    const r = classifyInboundAttachments([{ Name: 'a.docx', ContentType: 'application/msword', Content: 'AAAA' }, pdf({ Content: '' })], '')
    expect(r.usable).toHaveLength(0)
    expect(r.unsupportedTypes).toEqual(['application/msword'])
  })
  it('de-duplicates unsupported types', () => {
    const doc = { Name: 'a.docx', ContentType: 'application/msword', Content: 'AAAA' }
    expect(classifyInboundAttachments([doc, doc], '').unsupportedTypes).toEqual(['application/msword'])
  })
  it('keeps the original position as index and the raw bytes', () => {
    const r = classifyInboundAttachments([logo(), pdf()], html)
    expect(r.usable[0].index).toBe(1)
    expect(Buffer.isBuffer(r.usable[0].bytes)).toBe(true)
  })
  it('tolerates a missing attachment list', () => {
    expect(classifyInboundAttachments(undefined, undefined).usable).toEqual([])
  })
  const pngOf = (size) => Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(size - 8),
  ]).toString('base64')
  it('keeps a large inline image beside a PDF (a photographed receipt)', () => {
    expect(INLINE_IMAGE_SKIP_MAX_BYTES).toBe(100 * 1024)
    const r = classifyInboundAttachments([pdf(), logo({ Content: pngOf(150 * 1024) })], html)
    expect(r.usable).toHaveLength(2)
    expect(r.skippedInline).toBe(0)
  })
  it('skips a small inline image beside a PDF', () => {
    const r = classifyInboundAttachments([pdf(), logo({ Content: pngOf(20 * 1024) })], html)
    expect(r.usable.map((a) => a.name)).toEqual(['a.pdf'])
    expect(r.skippedInline).toBe(1)
  })
  it('matches the ContentID exactly: a1 is not referenced by cid:a10', () => {
    const r = classifyInboundAttachments([pdf(), logo({ ContentID: 'a1' })], '<img src="cid:a10">')
    expect(r.skippedInline).toBe(0)
    expect(r.usable).toHaveLength(2)
  })
  it('uses bytes already read from Storage when Content is empty', () => {
    const doc = { Name: 'a.docx', ContentType: 'application/msword', Content: 'AAAA' }
    const staged = { Name: 'big.pdf', ContentType: 'application/octet-stream', Content: '', bytes: Buffer.from('%PDF-1.4 x') }
    const r = classifyInboundAttachments([doc, staged], '')
    expect(r.usable).toHaveLength(1)
    expect(r.usable[0]).toMatchObject({ name: 'big.pdf', mime: 'application/pdf', index: 1 })
    expect(Buffer.isBuffer(r.usable[0].bytes)).toBe(true)
  })
  it('accepts a Uint8Array as the bytes', () => {
    const r = classifyInboundAttachments([{ Name: 'a.pdf', Content: '', bytes: new Uint8Array(Buffer.from('%PDF-1.4 x')) }], '')
    expect(r.usable[0]).toMatchObject({ mime: 'application/pdf', index: 0 })
    expect(Buffer.isBuffer(r.usable[0].bytes)).toBe(true)
  })
  it('skips an inline logo when the only other attachment is already stored', () => {
    const r = classifyInboundAttachments([null, logo()], html, { alreadyStored: [{ mime: 'application/pdf', sizeBytes: 5000 }] })
    expect(r.usable).toEqual([])
    expect(r.skippedInline).toBe(1)
  })
  it('counts a stored attachment with unknown type or size as a real one', () => {
    const r = classifyInboundAttachments([null, logo()], html, { alreadyStored: [{ mime: null, sizeBytes: null }] })
    expect(r.skippedInline).toBe(1)
  })
  it('keeps an inline image when the only stored one was itself an inline image', () => {
    const r = classifyInboundAttachments([null, logo()], '<img src="cid:cid1"><img src="cid:cid0">', {
      alreadyStored: [{ mime: 'image/png', sizeBytes: 16, contentId: 'cid0' }],
    })
    expect(r.usable).toHaveLength(1)
    expect(r.skippedInline).toBe(0)
  })
  it('matches a ContentID at the end of the body or before a delimiter', () => {
    expect(classifyInboundAttachments([pdf(), logo({ ContentID: 'a1' })], 'see cid:A1').skippedInline).toBe(1)
    expect(classifyInboundAttachments([pdf(), logo({ ContentID: 'a.1' })], "<img src='cid:a.1'>").skippedInline).toBe(1)
    expect(classifyInboundAttachments([pdf(), logo({ ContentID: 'a.1' })], '<img src="cid:aX1">').skippedInline).toBe(0)
  })
})

describe('inboundBodyText', () => {
  it('prefers TextBody, falls back to HtmlBody, trims to 20000', () => {
    expect(inboundBodyText({ TextBody: ' hello ' })).toBe('hello')
    expect(inboundBodyText({ HtmlBody: '<p>hello</p>' })).toBe('hello')
    expect(inboundBodyText({ TextBody: 'x'.repeat(30000) })).toHaveLength(20000)
    expect(inboundBodyText({})).toBeNull()
  })
})

describe('attachmentMessageId and sha256Hex', () => {
  it('numbers attachments the way existing rows are numbered', () => {
    expect(attachmentMessageId('m', 0)).toBe('m')
    expect(attachmentMessageId('m', 2)).toBe('m-2')
  })
  it('hashes bytes as lowercase hex sha256', () => {
    expect(sha256Hex(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})
