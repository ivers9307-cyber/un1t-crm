// Contractor invoice notification emails — approval + decline.
//
// Both emails go to the contractor's email on their profile via
// Postmark. Branded with the location's logo when one is configured
// (mirrors the approach used by deposit-receipts.js / roster-email).
//
// Sent best-effort: if the email send fails we still record the
// approval/decline status in the DB and return a warning to the
// caller. The contractor will see the status next time they open
// /schedule/invoices, so the workflow doesn't hang on Postmark.

import { createServerClient } from '@/lib/supabase'
import { periodLabel } from './contractor-invoices.js'
import { formatFullDateTimeInTZ } from './dates.js'
import { getLocationBranding } from './location-branding.js'
import { resolvePostmarkToken } from './postmark-token.js'

const POSTMARK_API_URL = 'https://api.postmarkapp.com'

function getPostmarkToken() {
  return resolvePostmarkToken()
}

function getFromAddress() {
  return process.env.POSTMARK_FROM_EMAIL || 'UN1T <hello@un1t.ie>'
}

function appUrl() {
  // REPSET-P6.S2 — env stays primary; the code default is the canonical
  // repset host (the legacy host keeps serving, but links lead with repset).
  return process.env.NEXT_PUBLIC_APP_URL || 'https://crm.repset.ie'
}

async function postmarkSend({ to, subject, htmlBody, textBody, tag, metadata }) {
  const token = getPostmarkToken()
  if (!token) throw new Error('Postmark is not configured (set POSTMARK_API_KEY).')
  const res = await fetch(`${POSTMARK_API_URL}/email`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': token,
    },
    body: JSON.stringify({
      From: getFromAddress(),
      To: to,
      Subject: subject,
      HtmlBody: htmlBody,
      TextBody: textBody,
      MessageStream: 'outbound',
      Tag: tag,
      Metadata: metadata,
      TrackOpens: false,
      TrackLinks: 'None',
    }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json?.Message || `Postmark ${res.status}`)
  return json.MessageID
}

async function loadInvoiceForEmail(invoiceId) {
  const db = createServerClient()
  const { data, error } = await db
    .from('contractor_invoices')
    .select(`
      id, period_start, period_end, invoice_amount, status,
      decline_reason, approved_at, reviewed_by, location_id,
      contractor:contractor_id ( full_name, email ),
      reviewer:reviewed_by ( full_name )
    `)
    .eq('id', invoiceId)
    .single()
  if (error || !data) throw new Error(`Invoice not found: ${error?.message || 'unknown'}`)
  // Branding (logo + company name) lives on company_settings keyed by
  // location_id — the locations table has neither logo_url nor
  // company_name, so embedding them there returned nothing. Resolve via
  // the shared helper (never throws; falls back to a neutral 'UN1T').
  const branding = await getLocationBranding(db, data.location_id)
  return { ...data, branding }
}

function brandHeader(branding) {
  if (branding?.logoUrl) {
    return `<img src="${escapeAttr(branding.logoUrl)}" alt="${escapeAttr(branding.companyName || 'Logo')}" style="max-height:48px;margin-bottom:16px" />`
  }
  return `<div style="font-size:24px;font-weight:bold;letter-spacing:2px;margin-bottom:16px">${escapeHtml(branding?.companyName || 'UN1T')}</div>`
}

export async function sendInvoiceApprovedEmail(invoiceId) {
  const inv = await loadInvoiceForEmail(invoiceId)
  if (!inv.contractor?.email) {
    return { skipped: true, reason: 'No contractor email on file' }
  }

  const period = periodLabel(inv.period_start)
  const subject = `Invoice approved — ${period}`
  const htmlBody = `
    <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:600px">
      ${brandHeader(inv.branding)}
      <div style="background:#10B981;color:white;padding:16px;border-radius:8px;text-align:center;margin-bottom:24px">
        <div style="font-size:32px;line-height:1">✓</div>
        <div style="font-weight:bold;font-size:18px;margin-top:6px">Invoice approved</div>
      </div>
      <p>Hi ${escapeHtml(inv.contractor.full_name || 'there')},</p>
      <p>Your invoice for <strong>${period}</strong> has been approved${
        inv.reviewer?.full_name ? ` by ${escapeHtml(inv.reviewer.full_name)}` : ''
      } and forwarded to our accounts package for payment processing.</p>
      <table style="border-collapse:collapse;margin:16px 0">
        <tr><td style="padding:4px 12px 4px 0;color:#666">Period</td><td style="padding:4px 0">${period}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Amount</td><td style="padding:4px 0">€${Number(inv.invoice_amount).toFixed(2)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Approved at</td><td style="padding:4px 0">${formatFullDateTimeInTZ(inv.approved_at)}</td></tr>
      </table>
      <p>You can review your submission history at <a href="${appUrl()}/schedule/invoices">${appUrl()}/schedule/invoices</a>.</p>
      <p style="color:#666;font-size:13px;margin-top:24px">
        Thanks for your work this month.
      </p>
    </div>
  `.trim()
  const textBody =
    `Hi ${inv.contractor.full_name || 'there'},\n\n` +
    `Your invoice for ${period} has been approved and forwarded for payment.\n\n` +
    `Amount: €${Number(inv.invoice_amount).toFixed(2)}\n` +
    `Approved at: ${formatFullDateTimeInTZ(inv.approved_at)}\n\n` +
    `Review your submission history: ${appUrl()}/schedule/invoices\n`

  const messageId = await postmarkSend({
    to: inv.contractor.email,
    subject, htmlBody, textBody,
    tag: 'contractor-invoice-approved',
    metadata: { invoice_id: inv.id, contractor_id: inv.contractor?.id || null },
  })
  return { messageId }
}

export async function sendInvoiceDeclinedEmail(invoiceId) {
  const inv = await loadInvoiceForEmail(invoiceId)
  if (!inv.contractor?.email) {
    return { skipped: true, reason: 'No contractor email on file' }
  }

  const period = periodLabel(inv.period_start)
  const subject = `Invoice needs adjustment — ${period}`
  const htmlBody = `
    <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:600px">
      ${brandHeader(inv.branding)}
      <div style="background:#F59E0B;color:white;padding:16px;border-radius:8px;text-align:center;margin-bottom:24px">
        <div style="font-weight:bold;font-size:18px">Invoice needs adjustment</div>
      </div>
      <p>Hi ${escapeHtml(inv.contractor.full_name || 'there')},</p>
      <p>Your invoice for <strong>${period}</strong> needs an adjustment before it can be approved${
        inv.reviewer?.full_name ? `. Reviewed by ${escapeHtml(inv.reviewer.full_name)}.` : '.'
      }</p>
      ${inv.decline_reason ? `
        <div style="background:#FEF3C7;border-left:3px solid #F59E0B;padding:12px;margin:16px 0;color:#78350F">
          <div style="font-weight:bold;margin-bottom:4px">Reason</div>
          <div>${escapeHtml(inv.decline_reason)}</div>
        </div>
      ` : ''}
      <p>You can resubmit a corrected invoice for the same month at <a href="${appUrl()}/schedule/invoices">${appUrl()}/schedule/invoices</a>.</p>
      <p style="color:#666;font-size:13px;margin-top:24px">
        If you have questions about the reason, reply directly to this email and the studio team will get back to you.
      </p>
    </div>
  `.trim()
  const textBody =
    `Hi ${inv.contractor.full_name || 'there'},\n\n` +
    `Your invoice for ${period} needs an adjustment before it can be approved.\n\n` +
    (inv.decline_reason ? `Reason: ${inv.decline_reason}\n\n` : '') +
    `Resubmit a corrected invoice: ${appUrl()}/schedule/invoices\n`

  const messageId = await postmarkSend({
    to: inv.contractor.email,
    subject, htmlBody, textBody,
    tag: 'contractor-invoice-declined',
    metadata: { invoice_id: inv.id, contractor_id: inv.contractor?.id || null },
  })
  return { messageId }
}

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}
function escapeAttr(s) {
  return escapeHtml(s)
}
