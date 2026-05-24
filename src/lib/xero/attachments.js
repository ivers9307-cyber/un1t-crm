// XERO-ATTACH.1 — upload a file as an attachment on a Xero record.
//
// Used by the invoice ingest to attach the *original* supplier
// document to the draft Bill it pushes — so the bookkeeper /
// accountant sees the source PDF right next to the figures in Xero,
// the same way Dext attaches the source receipt.
//
// Xero's attachment endpoint takes the raw file bytes as the request
// body (not multipart) with the file's own Content-Type, and the
// filename in the URL path:
//   POST /{Endpoint}/{Guid}/Attachments/{FileName}
//
// Reference: https://developer.xero.com/documentation/api/accounting/attachments

import { XeroError } from '@/lib/xero/client'

// Xero rejects filenames containing path / wildcard characters and
// caps the length. Strip anything risky and fall back to a generic
// name so a weird supplier filename can't break the upload.
export function safeAttachmentFilename(name, fallback = 'invoice.pdf') {
  const cleaned = String(name || '')
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
  return cleaned || fallback
}

/**
 * Attach a file to a Xero invoice / bill.
 *
 * @param {Function} xfetch     authed fetch from withFreshToken()
 * @param {string}   invoiceId  Xero InvoiceID (GUID)
 * @param {{ filename?: string, mimeType?: string, bytes: Buffer|Uint8Array }} file
 * @returns the created attachment record from Xero
 */
export async function attachInvoiceFile(xfetch, invoiceId, { filename, mimeType, bytes } = {}) {
  if (!invoiceId) throw new XeroError('attachInvoiceFile: invoiceId is required')
  if (!bytes || !bytes.length) throw new XeroError('attachInvoiceFile: no file bytes to upload')

  const name = safeAttachmentFilename(filename)
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)

  const res = await xfetch(
    `/Invoices/${encodeURIComponent(invoiceId)}/Attachments/${encodeURIComponent(name)}`,
    {
      method: 'POST',
      body,
      headers: { 'Content-Type': mimeType || 'application/octet-stream' },
    },
  )
  return res?.Attachments?.[0] || res
}
