// INVOICES-QUEUE.1 PR 2 — unified Xero forwarder.
//
// Takes a single invoices_queue row (any source_type) and forwards
// the attachment to the location's Xero bills_email_address. Reads
// the attachment from whichever Supabase bucket the row points at
// (attachment_bucket column populated by mig 185).
//
// One email per row = one draft bill in Xero. For FTE expense
// claims with N receipts, that means N draft bills — keeps each
// receipt independently auditable and matches the per-row queue
// granularity. (The pre-INVOICES-QUEUE.1 helper bundled the whole
// claim into one email; the bookkeeper can still merge drafts in
// Xero if they prefer that posture.)
//
// Status transitions handled by the bulk-send route, not here —
// this lib just does the send.

import { createServerClient } from '@/lib/supabase'
import { XeroError } from '@/lib/xero/client'

const POSTMARK_API_URL = 'https://api.postmarkapp.com'

function getPostmarkToken() {
  const t = process.env.POSTMARK_API_KEY
  if (!t) throw new XeroError('POSTMARK_API_KEY is not configured.')
  return t
}

function getFromAddress() {
  return process.env.POSTMARK_FROM_EMAIL || 'UN1T <hello@un1t.ie>'
}

async function postmarkSendWithAttachment({ to, subject, htmlBody, attachment, replyTo, metadata, tag }) {
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
    Tag: tag || 'xero-invoices-queue',
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

function fileExtForMime(mime) {
  switch (mime) {
    case 'application/pdf': return 'pdf'
    case 'image/png':       return 'png'
    case 'image/jpeg':      return 'jpg'
    case 'image/gif':       return 'gif'
    case 'image/webp':      return 'webp'
    default:                return 'bin'
  }
}

function currencySym(code) {
  if (code === 'EUR') return '€'
  if (code === 'GBP') return '£'
  if (code === 'USD') return '$'
  return ''
}

/**
 * Build the per-source email envelope (subject, body, filename,
 * replyTo, tag, metadata). All source types share the same envelope
 * SHAPE — just different copy and metadata.
 */
function buildEnvelope(row, sourceContext) {
  const f = row.extracted_fields || {}
  const supplier = f.supplier_name || sourceContext.supplierFallback || 'Supplier'
  const invoiceNumber = f.invoice_number
  const invoiceDate = f.invoice_date
  const total = f.total
  const currency = f.currency || 'EUR'
  const sym = currencySym(currency)
  const category = f.category
  const categoryLabel = category
    ? category.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')
    : null
  const accountCode = f.account_code

  const safeSupplier = supplier.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)
  const ext = fileExtForMime(row.attachment_mime_type)
  const filename = invoiceNumber
    ? `${safeSupplier}-${invoiceNumber}.${ext}`
    : (row.attachment_filename || `${safeSupplier}.${ext}`)

  const subject = invoiceNumber
    ? `Invoice — ${supplier} — ${invoiceNumber}`
    : `Invoice — ${supplier}`

  const htmlBody = `
    <p>Approved invoice forwarded from UN1T CRM (Invoices queue).</p>
    <ul>
      <li>Source: <strong>${sourceContext.sourceLabel}</strong></li>
      <li>Supplier: <strong>${supplier}</strong></li>
      ${invoiceNumber ? `<li>Invoice #: <strong>${invoiceNumber}</strong></li>` : ''}
      ${invoiceDate ? `<li>Invoice date: <strong>${invoiceDate}</strong></li>` : ''}
      ${typeof total === 'number' ? `<li>Total: <strong>${sym}${total.toFixed(2)} ${currency}</strong></li>` : ''}
      ${categoryLabel ? `<li>Suggested category: <strong>${categoryLabel}</strong></li>` : ''}
      ${accountCode ? `<li>Suggested Xero account: <strong>${accountCode}</strong></li>` : ''}
      <li>Location: ${row.location?.name || 'n/a'}</li>
      ${row.sender_email ? `<li>Originally received from: ${row.sender_email}</li>` : ''}
      ${sourceContext.extraMeta || ''}
    </ul>
    <p>Xero will OCR this attachment and create a draft bill in Bills to pay → Draft. The category and account hints above were confirmed by the bookkeeper — use them when posting the draft, or override if the chart of accounts disagrees.</p>
  `.trim()

  return {
    subject,
    htmlBody,
    filename,
    replyTo: row.sender_email || undefined,
    tag: `xero-invoices-queue-${row.source_type}`,
    metadata: {
      queue_id: row.id,
      source_type: row.source_type,
      location_id: row.location_id,
      ...(sourceContext.extraMetadata || {}),
    },
  }
}

/**
 * Forward a single invoices_queue row to its location's Xero bills
 * email. Throws XeroError on misconfiguration or transport failure;
 * caller is responsible for status flips + persisting the returned
 * MessageID.
 *
 * @param {string} queueId invoices_queue.id
 * @returns {Promise<{ messageId, submittedAt, sentTo, filename }>}
 */
export async function forwardQueueRowToXero(queueId) {
  const db = createServerClient()

  const { data: row, error: loadErr } = await db
    .from('invoices_queue')
    .select(`
      id, location_id, status, source_type,
      source_contractor_invoice_id, source_fte_expense_item_id, source_car_document_id,
      sender_email, subject,
      attachment_bucket, attachment_path, attachment_filename, attachment_mime_type,
      extracted_fields,
      location:location_id ( id, name )
    `)
    .eq('id', queueId)
    .single()
  if (loadErr || !row) throw new XeroError('Queue row not found.')
  if (row.status !== 'data_approved') {
    throw new XeroError(
      `Cannot forward a queue row in '${row.status}' state — must be data_approved.`
    )
  }
  if (!row.attachment_path) throw new XeroError('Queue row has no attachment to forward.')
  if (!row.attachment_bucket) throw new XeroError('Queue row has no attachment_bucket set.')

  // Pull the Xero bills email for the row's location.
  const { data: conn, error: connErr } = await db
    .from('xero_connections')
    .select('bills_email_address, tenant_name')
    .eq('location_id', row.location_id)
    .maybeSingle()
  if (connErr) throw new XeroError(`Failed to load Xero connection: ${connErr.message}`)
  if (!conn) {
    throw new XeroError(
      `No Xero connection for ${row.location?.name || 'this location'}. Connect Xero in Settings first.`
    )
  }
  if (!conn.bills_email_address) {
    throw new XeroError(
      `No bills-email address configured for ${conn.tenant_name || 'this location'}. ` +
      `Add it in Settings → Integrations.`
    )
  }

  // Build the per-source context. Each branch contributes the
  // "Source:" label, optional metadata lines, and reply-to fallback.
  // Keeps source-specific knowledge in one place per branch.
  let sourceContext
  if (row.source_type === 'supplier_email') {
    sourceContext = {
      sourceLabel: 'Supplier email',
      supplierFallback: null,
      extraMeta: '',
      extraMetadata: {},
    }
  } else if (row.source_type === 'contractor_invoice') {
    const { data: inv } = await db
      .from('contractor_invoices')
      .select('id, period_start, period_end, invoice_number, contractor:contractor_id(full_name, email)')
      .eq('id', row.source_contractor_invoice_id)
      .maybeSingle()
    const contractorName = inv?.contractor?.full_name || 'Contractor'
    sourceContext = {
      sourceLabel: `Contractor invoice — ${contractorName}`,
      supplierFallback: contractorName,
      extraMeta: inv?.period_start
        ? `<li>Period: ${inv.period_start} → ${inv.period_end || ''}</li>`
        : '',
      extraMetadata: {
        contractor_invoice_id: inv?.id || row.source_contractor_invoice_id,
        contractor_email: inv?.contractor?.email || null,
      },
    }
    if (!row.sender_email && inv?.contractor?.email) {
      // Set replyTo via row.sender_email indirection — buildEnvelope
      // reads row.sender_email for the replyTo. Patch the row's
      // sender_email locally so buildEnvelope picks it up without
      // a special branch.
      row.sender_email = inv.contractor.email
    }
  } else if (row.source_type === 'fte_expense_item') {
    const { data: item } = await db
      .from('fte_expense_items')
      .select(`
        id, vendor, expense_date, amount, category,
        claim:claim_id ( id, period_start, profile:profile_id ( full_name, email ) )
      `)
      .eq('id', row.source_fte_expense_item_id)
      .maybeSingle()
    const employeeName = item?.claim?.profile?.full_name || 'Employee'
    const itemCategory = item?.category ? `<li>Item category: ${item.category}</li>` : ''
    const periodLine = item?.claim?.period_start ? `<li>Claim period: ${item.claim.period_start.slice(0, 7)}</li>` : ''
    sourceContext = {
      sourceLabel: `Employee expense — ${employeeName}`,
      supplierFallback: item?.vendor || null,
      extraMeta: `${periodLine}${itemCategory}`,
      extraMetadata: {
        fte_expense_item_id: item?.id || row.source_fte_expense_item_id,
        fte_claim_id: item?.claim?.id || null,
        employee_email: item?.claim?.profile?.email || null,
      },
    }
    if (!row.sender_email && item?.claim?.profile?.email) {
      row.sender_email = item.claim.profile.email
    }
  } else if (row.source_type === 'car_document') {
    const { data: doc } = await db
      .from('car_documents')
      .select(`
        id, doc_type, filename,
        car:car_id ( id, make, model, uk_reg, irish_reg )
      `)
      .eq('id', row.source_car_document_id)
      .maybeSingle()
    const carLabel = [doc?.car?.make, doc?.car?.model, doc?.car?.uk_reg || doc?.car?.irish_reg]
      .filter(Boolean)
      .join(' ') || 'Car'
    sourceContext = {
      sourceLabel: `Car document — ${carLabel}`,
      supplierFallback: null,
      extraMeta: `<li>Document type: ${doc?.doc_type || 'document'}</li>`,
      extraMetadata: {
        car_document_id: doc?.id || row.source_car_document_id,
        car_id: doc?.car?.id || null,
      },
    }
  } else {
    throw new XeroError(`Unknown source_type: ${row.source_type}`)
  }

  // Pull the attachment from the source's own bucket.
  const { data: blob, error: dlErr } = await db.storage
    .from(row.attachment_bucket)
    .download(row.attachment_path)
  if (dlErr || !blob) {
    throw new XeroError(`Could not download attachment from ${row.attachment_bucket}: ${dlErr?.message || 'unknown error'}`)
  }
  const ab = await blob.arrayBuffer()
  const base64 = Buffer.from(ab).toString('base64')

  const env = buildEnvelope(row, sourceContext)

  const result = await postmarkSendWithAttachment({
    to: conn.bills_email_address,
    subject: env.subject,
    htmlBody: env.htmlBody,
    replyTo: env.replyTo,
    attachment: {
      Name: env.filename,
      Content: base64,
      ContentType: row.attachment_mime_type || 'application/octet-stream',
    },
    metadata: env.metadata,
    tag: env.tag,
  })

  return {
    messageId: result.messageId,
    submittedAt: result.submittedAt,
    sentTo: conn.bills_email_address,
    filename: env.filename,
    sourceType: row.source_type,
  }
}
