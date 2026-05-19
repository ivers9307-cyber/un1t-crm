// INVOICES.1 — pure-helper coverage for inbound_invoices flow.
//
// Address parsing matters most (single bug = lost invoices), so
// give it the deepest case list: case folding, +tag stripping,
// Postmark's "ToFull" array shape, display-name wrappers, and the
// obvious negatives (wrong domain, bad slug shape).

import { describe, it, expect } from 'vitest'
import {
  parseInboundAddress,
  INBOUND_INVOICE_SUPPORTED_MIME,
  INBOUND_INVOICE_STATUSES,
  INBOUND_INVOICE_TRANSITIONS,
  canTransitionInboundInvoice,
  inboundInvoiceStoragePath,
  safeInboundFilename,
} from './inbound-invoices.js'

describe('parseInboundAddress', () => {
  it('extracts slug from a plain string recipient', () => {
    expect(parseInboundAddress('dublin-city-invoices@un1tdublin.com')).toBe('dublin-city')
  })

  it('case-folds the local part and domain', () => {
    expect(parseInboundAddress('DUBLIN-CITY-Invoices@UN1Tdublin.COM')).toBe('dublin-city')
  })

  it('strips display name from "Name <addr>" format', () => {
    expect(parseInboundAddress('Vendor Co <accounts-invoices@un1tdublin.com>')).toBe('accounts')
  })

  it('strips Postmark +tag suffix', () => {
    expect(parseInboundAddress('dublin-invoices+x@un1tdublin.com')).toBe('dublin')
  })

  it('accepts the Postmark ToFull array shape', () => {
    const toFull = [
      { Email: 'other@example.com', Name: 'Other' },
      { Email: 'foo-invoices@un1tdublin.com', Name: 'Foo Address' },
    ]
    expect(parseInboundAddress(toFull)).toBe('foo')
  })

  it('handles the OriginalRecipient single-string form (Postmark spec)', () => {
    // Per Postmark docs OriginalRecipient is a plain string with
    // the envelope RCPT TO. The same parser handles it because we
    // accept either string or { Email } objects.
    expect(parseInboundAddress('dublin-invoices@un1tdublin.com')).toBe('dublin')
  })

  it('handles plus-addressing on the slug local part', () => {
    // Postmark uses MailboxHash for the +-suffix. Our parser
    // strips it from the local part so the slug still matches.
    expect(parseInboundAddress('dublin-invoices+ref-123@un1tdublin.com')).toBe('dublin')
  })

  it('returns null on a wrong domain', () => {
    expect(parseInboundAddress('dublin-invoices@example.com')).toBeNull()
  })

  it('returns null on a slug that fails the regex', () => {
    // Starts with a hyphen — DB CHECK would reject this too.
    expect(parseInboundAddress('-bad-invoices@un1tdublin.com')).toBeNull()
  })

  it('returns null when the local part is not the *-invoices form', () => {
    expect(parseInboundAddress('hello@un1tdublin.com')).toBeNull()
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
