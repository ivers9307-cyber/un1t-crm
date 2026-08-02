// Bills auto-forward via Xero's "Email to Bills" address.
//
// Each Xero org has a unique email-in address (found in the Xero UI
// under Bills to pay → Create bill from email). PDFs sent there as
// attachments are auto-OCR'd by Xero/Hubdoc and dropped into the
// drafts queue at Business → Bills to pay → Draft. No org-level
// "Convert files to bills" toggle needed — this path is built into
// every Xero org by default.
//
// Why email over the Files API: the Files Inbox approach we tried
// first requires the operator to flip a per-org "Convert files to
// bills" setting before anything happens automatically. Email-to-
// bills is the documented Xero-supported path that doesn't need
// any user-side configuration beyond pasting the address into our
// settings UI once.
//
// We send via Postmark using its Attachments support. The supplier
// shows up in the Reply-To so the accountant can chase the supplier
// directly from the draft bill if needed (Xero exposes the from
// address on the resulting draft).

import { createServerClient } from '@/lib/supabase'
import { resolvePostmarkToken } from '@/lib/postmark-token'
import { XeroError } from './client'

const STORAGE_BUCKET = 'car-documents'
const POSTMARK_API_URL = 'https://api.postmarkapp.com'

// Doc-type label for the email subject line. Falls back to the
// stored doc_type slug if the operator added a custom type later.
const DOC_TYPE_LABELS = {
  nct_invoice: 'NCT invoice',
  irish_customs: 'Irish customs invoice',
  bca_invoice: 'BCA invoice',
  transporter: 'Transporter invoice',
  ferry_invoice: 'Ferry invoice',
  other: 'Document',
}

function getPostmarkToken() {
  const t = resolvePostmarkToken()
  if (!t) throw new XeroError('Postmark is not configured (set POSTMARK_API_KEY).')
  return t
}

function getFromAddress() {
  return process.env.POSTMARK_FROM_EMAIL || 'UN1T <hello@un1t.ie>'
}

// POST /email — single send, with attachment.
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
    Tag: 'xero-bill-forward',
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
 * Forward a single car_documents row to the org's Xero bills email.
 * Returns the Postmark message id so the caller can save it as
 * proof-of-send on the row.
 */
export async function sendCarDocumentBillEmail(documentId) {
  const db = createServerClient()

  // Pull the doc + its car + the Xero connection for the car's
  // location, all in one round-trip.
  const { data: doc, error: loadErr } = await db
    .from('car_documents')
    .select(`
      id, car_id, doc_type, file_name, mime_type, storage_path,
      cars!inner ( id, location_id, uk_reg, irish_reg, vin, make, model )
    `)
    .eq('id', documentId)
    .single()
  if (loadErr || !doc) throw new XeroError('Document not found.')

  const car = doc.cars
  if (!car?.location_id) throw new XeroError("Document's car has no location_id.")

  const { data: conn, error: connErr } = await db
    .from('xero_connections')
    .select('bills_email_address, tenant_name')
    .eq('location_id', car.location_id)
    .maybeSingle()
  if (connErr) throw new XeroError(`Failed to load Xero connection: ${connErr.message}`)
  if (!conn) throw new XeroError('No Xero connection for this location. Connect Xero in Settings first.')
  if (!conn.bills_email_address) {
    throw new XeroError(
      `No bills-email address configured for ${conn.tenant_name || 'this location'}. ` +
      `Add it in Settings → Integrations (find the address in Xero under Bills to pay → Create bill from email).`
    )
  }

  // Pull the actual bytes from Supabase Storage and base64-encode
  // for Postmark.
  const { data: blob, error: dlErr } = await db.storage
    .from(STORAGE_BUCKET)
    .download(doc.storage_path)
  if (dlErr || !blob) {
    throw new XeroError(`Could not download "${doc.file_name}" from storage: ${dlErr?.message || 'unknown error'}`)
  }
  const ab = await blob.arrayBuffer()
  const base64 = Buffer.from(ab).toString('base64')

  // Annotate the filename with the car reg so the OCR-extracted
  // draft bill in Xero is easy to match back to the right car.
  const reg = car.uk_reg || car.irish_reg || car.vin || car.id
  const safeReg = String(reg).replace(/[^A-Za-z0-9_-]/g, '_')
  const docLabel = DOC_TYPE_LABELS[doc.doc_type] || doc.doc_type
  const filename = `${doc.doc_type}-${safeReg}-${doc.file_name || 'file'}`

  const subject = `${docLabel} — ${reg}`
  const htmlBody = `
    <p>Forwarded from UN1T CRM for car <strong>${reg}</strong> (${[car.make, car.model].filter(Boolean).join(' ') || 'vehicle'}).</p>
    <p>Document type: <strong>${docLabel}</strong></p>
    <p>Original filename: ${doc.file_name || 'n/a'}</p>
    <p>Xero will OCR this attachment and create a draft bill in Bills to pay → Draft.</p>
  `.trim()

  const result = await postmarkSendWithAttachment({
    to: conn.bills_email_address,
    subject,
    htmlBody,
    attachment: {
      Name: filename,
      Content: base64,
      ContentType: doc.mime_type || 'application/pdf',
    },
    metadata: {
      car_id: car.id,
      doc_id: doc.id,
      doc_type: doc.doc_type,
    },
  })

  return {
    messageId: result.messageId,
    submittedAt: result.submittedAt,
    sentTo: conn.bills_email_address,
    filename,
  }
}
