// INVOICES.1 — forward a data-approved inbound invoice to the
// location's Xero bills email. Mirrors the contractor-bills pattern:
// pull the original attachment out of the inbound-invoices bucket,
// send it via Postmark to the bills_email_address, return the
// Postmark MessageID so the caller can persist it onto
// inbound_invoices.xero_email_message_id.
//
// Why we forward the ORIGINAL attachment rather than re-rendering
// the extracted fields:
//   • Xero's own OCR runs against the attachment and creates the
//     draft bill. Our extracted_fields are for OUR data review +
//     audit trail — Xero doesn't take them as input over the
//     email channel.
//   • The original PDF/image is what the operator quality-approved
//     in stage 1. Re-rendering would introduce a divergence
//     between "what was reviewed" and "what reached Xero".
//   • If Xero's OCR disagrees with ours, the accountant can fix it
//     in Xero's draft-bill UI, which is the right place.

import { createServerClient } from '@/lib/supabase'
import { XeroError } from './client'

const STORAGE_BUCKET = 'inbound-invoices'
const POSTMARK_API_URL = 'https://api.postmarkapp.com'

function getPostmarkToken() {
  const t = process.env.POSTMARK_API_KEY
  if (!t) throw new XeroError('POSTMARK_API_KEY is not configured.')
  return t
}

function getFromAddress() {
  return process.env.POSTMARK_FROM_EMAIL || 'UN1T <hello@un1t.ie>'
}

async function postmarkSendWithAttachment({ to, subject, htmlBody, attachment, replyTo, metadata }) {
  const body = {
    From: getFromAddress(),
    To: to,
    Subject: subject,
    HtmlBody: htmlBody,
    MessageStream: 'outbound',
    TrackOpens: false,
    TrackLinks: 'None',
    Attachments: [attachment],
    ReplyTo: replyTo || undefined,
    Metadata: metadata || undefined,
    Tag: 'xero-inbound-invoice',
  }
  const res = await fetch(`${POSTMARK_API_URL}/email`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': getPostmarkToken(),
    },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new XeroError(json?.Message || `Postmark ${res.status}`, { status: res.status, body: json })
  }
  return { messageId: json.MessageID, submittedAt: json.SubmittedAt }
}

/**
 * Forward a data-approved inbound_invoices row to the location's
 * Xero bills email. Returns the Postmark MessageID; the caller is
 * responsible for stamping xero_email_message_id + xero_synced_at
 * + status='forwarded' onto the row.
 *
 * @param {string} invoiceId  inbound_invoices.id
 */
export async function sendInboundInvoiceBillEmail(invoiceId) {
  const db = createServerClient()

  const { data: inv, error: loadErr } = await db
    .from('invoices_queue')
    .select(`
      id, location_id, status, sender_email, subject,
      attachment_path, attachment_filename, attachment_mime_type,
      extracted_fields,
      location:location_id ( id, name )
    `)
    .eq('id', invoiceId)
    .single()
  if (loadErr || !inv) throw new XeroError('Inbound invoice not found.')
  if (inv.status !== 'data_approved') {
    throw new XeroError(
      `Cannot forward an invoice in '${inv.status}' state — must be data_approved.`
    )
  }
  if (!inv.attachment_path) throw new XeroError('Inbound invoice has no attachment to forward.')

  const { data: conn, error: connErr } = await db
    .from('xero_connections')
    .select('bills_email_address, tenant_name')
    .eq('location_id', inv.location_id)
    .maybeSingle()
  if (connErr) throw new XeroError(`Failed to load Xero connection: ${connErr.message}`)
  if (!conn) {
    throw new XeroError(
      `No Xero connection for ${inv.location?.name || 'this location'}. Connect Xero in Settings first.`
    )
  }
  if (!conn.bills_email_address) {
    throw new XeroError(
      `No bills-email address configured for ${conn.tenant_name || 'this location'}. ` +
      `Add it in Settings → Integrations (find the address in Xero under Bills to pay → Create bill from email).`
    )
  }

  // Pull the original attachment from the private inbound-invoices
  // bucket. Service-role bypasses RLS.
  const { data: blob, error: dlErr } = await db.storage
    .from(STORAGE_BUCKET)
    .download(inv.attachment_path)
  if (dlErr || !blob) {
    throw new XeroError(`Could not download attachment from storage: ${dlErr?.message || 'unknown error'}`)
  }
  const ab = await blob.arrayBuffer()
  const base64 = Buffer.from(ab).toString('base64')

  const supplier = inv.extracted_fields?.supplier_name || 'Supplier'
  const invoiceNumber = inv.extracted_fields?.invoice_number
  const invoiceDate = inv.extracted_fields?.invoice_date
  const total = inv.extracted_fields?.total
  const currency = inv.extracted_fields?.currency || 'EUR'
  const currencySymbol = currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : currency === 'USD' ? '$' : ''
  // INVOICES.3 — operator-confirmed category + account code. Bookkeepers
  // pick up the draft bill in Xero (created by Xero's own OCR from
  // the attachment) and use these as hints when posting it to the
  // right account. We pretty-print the snake_case category for
  // readability.
  const category = inv.extracted_fields?.category
  const categoryLabel = category
    ? category.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')
    : null
  const accountCode = inv.extracted_fields?.account_code

  const safeSupplier = supplier.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)
  const fallbackExt = (inv.attachment_mime_type === 'application/pdf') ? 'pdf'
    : (inv.attachment_mime_type === 'image/png') ? 'png'
    : (inv.attachment_mime_type === 'image/jpeg') ? 'jpg'
    : (inv.attachment_mime_type === 'image/gif') ? 'gif'
    : (inv.attachment_mime_type === 'image/webp') ? 'webp'
    : 'bin'
  const filename = invoiceNumber
    ? `${safeSupplier}-${invoiceNumber}.${fallbackExt}`
    : (inv.attachment_filename || `${safeSupplier}.${fallbackExt}`)

  const subject = invoiceNumber
    ? `Invoice — ${supplier} — ${invoiceNumber}`
    : `Invoice — ${supplier}`

  const htmlBody = `
    <p>Approved supplier invoice forwarded from UN1T CRM (Invoices inbox).</p>
    <ul>
      <li>Supplier: <strong>${supplier}</strong></li>
      ${invoiceNumber ? `<li>Invoice #: <strong>${invoiceNumber}</strong></li>` : ''}
      ${invoiceDate ? `<li>Invoice date: <strong>${invoiceDate}</strong></li>` : ''}
      ${typeof total === 'number' ? `<li>Total: <strong>${currencySymbol}${total.toFixed(2)} ${currency}</strong></li>` : ''}
      ${categoryLabel ? `<li>Suggested category: <strong>${categoryLabel}</strong></li>` : ''}
      ${accountCode ? `<li>Suggested Xero account: <strong>${accountCode}</strong></li>` : ''}
      <li>Location: ${inv.location?.name || 'n/a'}</li>
      ${inv.sender_email ? `<li>Originally received from: ${inv.sender_email}</li>` : ''}
    </ul>
    <p>Xero will OCR this attachment and create a draft bill in Bills to pay → Draft. The category and account hints above were suggested by Claude Vision and confirmed by the approver — use them when posting the draft, or override if your chart of accounts disagrees.</p>
  `.trim()

  const result = await postmarkSendWithAttachment({
    to: conn.bills_email_address,
    subject,
    htmlBody,
    replyTo: inv.sender_email || undefined,
    attachment: {
      Name: filename,
      Content: base64,
      ContentType: inv.attachment_mime_type || 'application/octet-stream',
    },
    metadata: {
      inbound_invoice_id: inv.id,
      location_id: inv.location_id,
    },
  })

  return {
    messageId: result.messageId,
    submittedAt: result.submittedAt,
    sentTo: conn.bills_email_address,
    filename,
  }
}
