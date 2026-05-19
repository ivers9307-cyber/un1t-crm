// FTE-EXPENSES.1 — forward an approved FTE expense claim to Xero
// via email-to-bills, same pattern as contractor invoices but with
// one attachment per line item instead of a single PDF.
//
// Xero's bills-from-email pipeline accepts multiple attachments per
// inbound email and creates one draft bill per attachment. Since we
// want a single bill per claim (so the accountant reconciles it as
// one payable to the employee, not five), we send ONE summary PDF
// listing the line items, OR rely on Xero's "combine attachments"
// behaviour by sending them all in one email and letting the
// accountant manually merge.
//
// For MVP: send all attachments in one email. Each receipt arrives
// in the bills inbox; the accountant uses Xero's "Add another
// attachment" to keep them under the same draft bill. Functional but
// adds a manual step. A follow-up branch can render a server-side
// summary PDF that lists all line items + amounts + VAT and attach
// THAT as the primary draft, with individual receipts as supporting
// attachments — the right end state but not blocking for v1.

import { createServerClient } from '@/lib/supabase'
import { XeroError } from './client'

const STORAGE_BUCKET = 'fte-expense-receipts'
const POSTMARK_API_URL = 'https://api.postmarkapp.com'

function getPostmarkToken() {
  const t = process.env.POSTMARK_API_KEY
  if (!t) throw new XeroError('POSTMARK_API_KEY is not configured.')
  return t
}

function getFromAddress() {
  return process.env.POSTMARK_FROM_EMAIL || 'UN1T <hello@un1t.ie>'
}

async function postmarkSendWithAttachments({ to, subject, htmlBody, attachments, replyTo, metadata }) {
  const body = {
    From: getFromAddress(),
    To: to,
    Subject: subject,
    HtmlBody: htmlBody,
    MessageStream: 'outbound',
    TrackOpens: false,
    TrackLinks: 'None',
    Attachments: attachments,
    ReplyTo: replyTo || undefined,
    Metadata: metadata || undefined,
    Tag: 'xero-fte-expense-claim',
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
 * Forward an approved FTE expense claim to the location's Xero
 * bills email. One email, N attachments (one per line item with a
 * receipt). Items without a receipt are still listed in the email
 * body but obviously can't be attached.
 *
 * Returns { messageId, submittedAt, sentTo } so the caller can
 * persist messageId on fte_expense_claims.xero_email_message_id.
 *
 * @param {string} claimId fte_expense_claims.id
 */
export async function sendFteExpenseClaimBillEmail(claimId) {
  const db = createServerClient()

  const { data: claim, error: loadErr } = await db
    .from('fte_expense_claims')
    .select(`
      id, profile_id, location_id,
      period_start, period_end,
      total_amount, total_vat_amount, item_count,
      notes, status,
      profile:profile_id ( id, full_name, email ),
      location:location_id ( id, name ),
      items:fte_expense_items (
        id, expense_date, category, vendor, description,
        amount, vat_amount, receipt_path, receipt_mime_type
      )
    `)
    .eq('id', claimId)
    .single()
  if (loadErr || !claim) throw new XeroError('Expense claim not found.')
  if (claim.status !== 'approved') {
    throw new XeroError(`Cannot forward a claim in '${claim.status}' state — must be approved.`)
  }
  if (!claim.location_id) throw new XeroError('Claim has no location_id.')

  const { data: conn, error: connErr } = await db
    .from('xero_connections')
    .select('bills_email_address, tenant_name')
    .eq('location_id', claim.location_id)
    .maybeSingle()
  if (connErr) throw new XeroError(`Failed to load Xero connection: ${connErr.message}`)
  if (!conn) {
    throw new XeroError(
      `No Xero connection for ${claim.location?.name || 'this location'}. Connect Xero in Settings first.`
    )
  }
  if (!conn.bills_email_address) {
    throw new XeroError(
      `No bills-email address configured for ${conn.tenant_name || 'this location'}. ` +
      `Add it in Settings → Integrations.`
    )
  }

  // Pull each receipt's bytes from Storage in parallel. Service-role
  // bypasses bucket RLS. Items without a receipt are tolerated —
  // Xero will still get the line-item summary in the email body and
  // the accountant can chase the missing receipts manually.
  const items = Array.isArray(claim.items) ? claim.items : []
  const itemsWithReceipts = items.filter((i) => i.receipt_path)

  const attachmentResults = await Promise.allSettled(
    itemsWithReceipts.map(async (item, idx) => {
      const { data: blob, error: dlErr } = await db.storage
        .from(STORAGE_BUCKET)
        .download(item.receipt_path)
      if (dlErr || !blob) {
        throw new Error(`item ${item.id}: ${dlErr?.message || 'download failed'}`)
      }
      const ab = await blob.arrayBuffer()
      const base64 = Buffer.from(ab).toString('base64')
      // Filename: 01-2026-05-03-Meals-receipt.{ext}. Numbered so
      // Xero's UI preserves the original receipt order, dated for
      // operator scannability.
      const seq = String(idx + 1).padStart(2, '0')
      const ext = inferExt(item.receipt_path, item.receipt_mime_type)
      const safeCat = String(item.category || 'item').replace(/[^A-Za-z0-9_-]/g, '_')
      return {
        Name: `${seq}-${item.expense_date}-${safeCat}-receipt.${ext}`,
        Content: base64,
        ContentType: item.receipt_mime_type || 'application/octet-stream',
      }
    })
  )

  const attachments = []
  const dlFailures = []
  for (const r of attachmentResults) {
    if (r.status === 'fulfilled') attachments.push(r.value)
    else dlFailures.push(r.reason?.message || String(r.reason))
  }
  if (attachments.length === 0 && itemsWithReceipts.length > 0) {
    throw new XeroError(
      `All receipt downloads failed (${dlFailures.length}): ${dlFailures.join('; ')}`
    )
  }

  const employeeName = claim.profile?.full_name || 'Employee'
  const periodLbl = new Date(`${claim.period_start}T00:00:00Z`)
    .toLocaleDateString('en-IE', { month: 'long', year: 'numeric', timeZone: 'UTC' })

  const subject = `Expense claim — ${employeeName} — ${periodLbl}`
  const itemRows = items.map((it) => `
    <tr>
      <td style="padding:4px 8px;border:1px solid #ddd">${it.expense_date}</td>
      <td style="padding:4px 8px;border:1px solid #ddd">${escapeHtml(it.category)}</td>
      <td style="padding:4px 8px;border:1px solid #ddd">${escapeHtml(it.vendor || '')}</td>
      <td style="padding:4px 8px;border:1px solid #ddd">${escapeHtml(it.description || '')}</td>
      <td style="padding:4px 8px;border:1px solid #ddd;text-align:right">€${Number(it.amount).toFixed(2)}</td>
      <td style="padding:4px 8px;border:1px solid #ddd;text-align:right">€${Number(it.vat_amount || 0).toFixed(2)}</td>
      <td style="padding:4px 8px;border:1px solid #ddd;text-align:center">${it.receipt_path ? '✓' : '—'}</td>
    </tr>
  `).join('')

  const htmlBody = `
    <p>Approved FTE expense claim forwarded from UN1T CRM.</p>
    <ul>
      <li>Employee: <strong>${escapeHtml(employeeName)}</strong></li>
      <li>Period: <strong>${escapeHtml(periodLbl)}</strong></li>
      <li>Total: <strong>€${Number(claim.total_amount).toFixed(2)}</strong>
        (incl. €${Number(claim.total_vat_amount).toFixed(2)} VAT)</li>
      <li>Location: ${escapeHtml(claim.location?.name || 'n/a')}</li>
      <li>Items: ${items.length}</li>
    </ul>
    <table style="border-collapse:collapse;font-size:12px;margin-top:12px">
      <thead>
        <tr>
          <th style="padding:4px 8px;border:1px solid #ddd;background:#f7f7f7">Date</th>
          <th style="padding:4px 8px;border:1px solid #ddd;background:#f7f7f7">Category</th>
          <th style="padding:4px 8px;border:1px solid #ddd;background:#f7f7f7">Vendor</th>
          <th style="padding:4px 8px;border:1px solid #ddd;background:#f7f7f7">Description</th>
          <th style="padding:4px 8px;border:1px solid #ddd;background:#f7f7f7">Amount</th>
          <th style="padding:4px 8px;border:1px solid #ddd;background:#f7f7f7">VAT</th>
          <th style="padding:4px 8px;border:1px solid #ddd;background:#f7f7f7">Receipt</th>
        </tr>
      </thead>
      <tbody>${itemRows}</tbody>
    </table>
    ${claim.notes ? `<p><strong>Notes from employee:</strong> ${escapeHtml(claim.notes)}</p>` : ''}
    <p>Reimbursement is paid via the next payroll run. ${attachments.length} receipt${attachments.length === 1 ? '' : 's'} attached. ${dlFailures.length > 0 ? `<em>(${dlFailures.length} receipt download${dlFailures.length === 1 ? '' : 's'} failed — chase from the CRM.)</em>` : ''}</p>
  `.trim()

  const result = await postmarkSendWithAttachments({
    to: conn.bills_email_address,
    subject,
    htmlBody,
    replyTo: claim.profile?.email || undefined,
    attachments,
    metadata: {
      fte_expense_claim_id: claim.id,
      profile_id: claim.profile_id,
      period_start: claim.period_start,
      total_amount: String(claim.total_amount),
    },
  })

  return {
    messageId: result.messageId,
    submittedAt: result.submittedAt,
    sentTo: conn.bills_email_address,
    attachmentCount: attachments.length,
    downloadFailures: dlFailures,
  }
}

function inferExt(path, mime) {
  if (typeof path === 'string') {
    const m = /\.([A-Za-z0-9]{2,5})$/.exec(path)
    if (m) return m[1].toLowerCase()
  }
  if (mime === 'application/pdf') return 'pdf'
  if (mime === 'image/png') return 'png'
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg'
  if (mime === 'image/heic') return 'heic'
  if (mime === 'image/webp') return 'webp'
  return 'bin'
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
