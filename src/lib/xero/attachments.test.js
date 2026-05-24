// XERO-ATTACH.1 — attachment helper coverage.
//
// attachInvoiceFile is a thin wrapper over the authed xfetch — we
// lock the filename sanitisation, the URL shape (endpoint + encoded
// filename), the raw-Buffer body + Content-Type header, and the
// empty-input guards.

import { describe, it, expect, vi } from 'vitest'
import { attachInvoiceFile, safeAttachmentFilename } from './attachments'

describe('safeAttachmentFilename', () => {
  it('keeps a clean filename as-is', () => {
    expect(safeAttachmentFilename('acme-invoice-2026.pdf')).toBe('acme-invoice-2026.pdf')
  })

  it('strips path / wildcard characters', () => {
    expect(safeAttachmentFilename('a/b\\c?d%e*f:g|h"i<j>k.pdf'))
      .toBe('a-b-c-d-e-f-g-h-i-j-k.pdf')
  })

  it('falls back when the name is empty', () => {
    expect(safeAttachmentFilename('')).toBe('invoice.pdf')
    expect(safeAttachmentFilename(null)).toBe('invoice.pdf')
  })

  it('caps the length at 240 chars', () => {
    expect(safeAttachmentFilename('x'.repeat(500)).length).toBe(240)
  })
})

describe('attachInvoiceFile', () => {
  it('POSTs raw bytes to the encoded attachment URL with the file Content-Type', async () => {
    const xfetch = vi.fn().mockResolvedValue({ Attachments: [{ AttachmentID: 'att-1' }] })
    const bytes = Buffer.from('%PDF-1.7 fake')
    const out = await attachInvoiceFile(xfetch, 'inv-guid-1', {
      filename: 'Acme Invoice.pdf',
      mimeType: 'application/pdf',
      bytes,
    })
    expect(xfetch).toHaveBeenCalledTimes(1)
    const [path, opts] = xfetch.mock.calls[0]
    expect(path).toBe('/Invoices/inv-guid-1/Attachments/Acme%20Invoice.pdf')
    expect(opts.method).toBe('POST')
    expect(Buffer.isBuffer(opts.body)).toBe(true)
    expect(opts.headers['Content-Type']).toBe('application/pdf')
    expect(out).toEqual({ AttachmentID: 'att-1' })
  })

  it('defaults the Content-Type when no mime type is given', async () => {
    const xfetch = vi.fn().mockResolvedValue({ Attachments: [] })
    await attachInvoiceFile(xfetch, 'inv-1', { filename: 'x.pdf', bytes: Buffer.from('ab') })
    expect(xfetch.mock.calls[0][1].headers['Content-Type']).toBe('application/octet-stream')
  })

  it('throws without an invoiceId', async () => {
    await expect(attachInvoiceFile(vi.fn(), '', { bytes: Buffer.from('ab') }))
      .rejects.toThrow(/invoiceId/)
  })

  it('throws on empty file bytes', async () => {
    await expect(attachInvoiceFile(vi.fn(), 'inv-1', { bytes: Buffer.alloc(0) }))
      .rejects.toThrow(/no file bytes/)
  })
})
