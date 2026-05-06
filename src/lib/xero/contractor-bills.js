// Forward an approved contractor invoice to Xero as a draft bill,
// using the same email-to-bills pipe as car_documents (see
// ./bills-email.js). Xero OCRs the attached PDF and creates a draft
// in Bills to pay → Draft.
//
// We don't push to Xero's /Invoices API directly here because the
// OCR-from-email pattern doesn't require any per-org toggle and
// gives the accountant the supplier name + amount already
// extracted. If we ever need finer control we can switch to the
// /Invoices ACCPAY endpoint, but at that point we'd also need to
// upsert the contractor as a Xero supplier contact, etc. — not
// worth it for the operator-facing workflow.

import { createServerClient } from '@/lib/supabase'
import { XeroError } from './client'

const STORAGE_BUCKET = 'contractor-invoices'
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
    Tag: 'xero-contractor-invoice',
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
 * Forward a contractor_invoices row to the location's Xero bills
 * email. Returns the Postmark message id; the caller persists that
 * onto contractor_invoices.xero_email_message_id and stamps
 * xero_synced_at = now.
 *
 * @param {string} invoiceId  contractor_invoices.id
 */
export async function sendContractorInvoiceBillEmail(invoiceId) {
  const db = createServerClient()

  const { data: inv, error: loadErr } = await db
    .from('contractor_invoices')
    .select(`
      id, contractor_id, location_id, period_start, period_end,
      invoice_amount, invoice_number, pdf_path, status,
      contractor:contractor_id ( id, full_name, email ),
      location:location_id ( id, name )
    `)
    .eq('id', invoiceId)
    .single()
  if (loadErr || !inv) throw new XeroError('Contractor invoice not found.')
  if (inv.status !== 'approved') {
    throw new XeroError(`Cannot forward an invoice in '${inv.status}' state — must be approved.`)
  }
  if (!inv.location_id) throw new XeroError('Invoice has no location_id.')

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

  // Pull the PDF bytes. Storage is private; service-role bypasses RLS.
  const { data: blob, error: dlErr } = await db.storage
    .from(STORAGE_BUCKET)
    .download(inv.pdf_path)
  if (dlErr || !blob) {
    throw new XeroError(`Could not download invoice PDF from storage: ${dlErr?.message || 'unknown error'}`)
  }
  const ab = await blob.arrayBuffer()
  const base64 = Buffer.from(ab).toString('base64')

  const periodLabel = new Date(inv.period_start + 'T00:00:00Z')
    .toLocaleDateString('en-IE', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  const contractorName = inv.contractor?.full_name || 'Contractor'
  const safeName = contractorName.replace(/[^A-Za-z0-9_-]/g, '_')
  const filename = `${safeName}-${inv.period_start}.pdf`

  const subject = `Contractor invoice — ${contractorName} — ${periodLabel}`
  const htmlBody = `
    <p>Approved contractor invoice forwarded from UN1T CRM.</p>
    <ul>
      <li>Contractor: <strong>${contractorName}</strong></li>
      <li>Period: <strong>${periodLabel}</strong></li>
      <li>Amount: <strong>€${Number(inv.invoice_amount).toFixed(2)}</strong></li>
      ${inv.invoice_number ? `<li>Contractor reference: ${inv.invoice_number}</li>` : ''}
      <li>Location: ${inv.location?.name || 'n/a'}</li>
    </ul>
    <p>Xero will OCR this attachment and create a draft bill in Bills to pay → Draft.</p>
  `.trim()

  const result = await postmarkSendWithAttachment({
    to: conn.bills_email_address,
    subject,
    htmlBody,
    replyTo: inv.contractor?.email || undefined,
    attachment: {
      Name: filename,
      Content: base64,
      ContentType: 'application/pdf',
    },
    metadata: {
      contractor_invoice_id: inv.id,
      contractor_id: inv.contractor_id,
      period_start: inv.period_start,
    },
  })

  return {
    messageId: result.messageId,
    submittedAt: result.submittedAt,
    sentTo: conn.bills_email_address,
    filename,
  }
}
