// Contract notification emails — issued, signed, declined, revoked.
//
// Sends via the existing postmark sendEmail() helper in src/lib/postmark.js.
// CONTRACTS-PDF.1 — the two SIGNED emails now carry the dual-signed PDF as
// an attachment when the sign route managed to generate one; every other
// sender here is attachment-free and both parties can still read the live
// HTML at /account/contracts/[id] (or print it) as before.
//
// All four senders are best-effort: if Postmark is down or the
// recipient bounces, we still record the contract action in the DB
// and surface a warning. The recipient sees the contract next time
// they open /account/contracts even if the email never arrives.
//
// Branded with the location's logo when configured (mirrors
// contractor-invoice-email.js).

import { createServerClient } from './supabase.js'
import { sendEmail } from './postmark.js'
import { formatFullDateTimeInTZ } from './dates.js'
import { getLocationBranding } from './location-branding.js'

function appUrl() {
  // REPSET-P6.S2 — env stays primary; the code default is the canonical
  // repset host (the legacy host keeps serving, but links lead with repset).
  return process.env.NEXT_PUBLIC_APP_URL || 'https://crm.repset.ie'
}

// CONTRACTS-PDF.1 — raw-bytes ceiling for an email attachment. Postmark's
// documented limit is 10MB for the entire message, and base64 inflates the
// payload by roughly a third, so 8MB of raw PDF is the practical cutoff.
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

/**
 * Resolve the contract's anchor location's operator-configured branding
 * ({ companyName, logoUrl }) from company_settings, via the shared
 * getLocationBranding helper. Never throws — a branding miss must not
 * break a contract notification; the email template degrades to the
 * plain "UN1T" wordmark.
 */
async function getBranding(locationId) {
  let db = null
  try {
    db = createServerClient()
  } catch {
    // createServerClient should never throw, but if it does the
    // null db makes getLocationBranding return its neutral default.
  }
  return getLocationBranding(db, locationId)
}

function brandedHeader(branding) {
  const companyName = branding?.companyName || 'UN1T'
  if (branding?.logoUrl) {
    return `<div style="text-align:center;padding:24px 0;">
      <img src="${branding.logoUrl}" alt="${escapeHtml(companyName)}" style="max-height:60px;max-width:200px;" />
    </div>`
  }
  return `<div style="text-align:center;padding:24px 0;font-size:24px;font-weight:bold;letter-spacing:0.05em;">${escapeHtml(companyName)}</div>`
}

function emailShell(innerHtml, branding) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
    ${brandedHeader(branding)}
    <div style="padding:0 32px 32px 32px;line-height:1.6;">
      ${innerHtml}
    </div>
    <div style="padding:24px 32px;border-top:1px solid #e5e7eb;font-size:11px;color:#6b7280;text-align:center;">
      UN1T Dublin Ltd · <a href="${appUrl()}/privacy" style="color:#6b7280;">Privacy</a>
    </div>
  </div>
</body>
</html>`
}

/**
 * Email the recipient when a master/owner issues them a contract.
 *
 * @param {object} args
 * @param {object} args.contract     — row from contracts table
 * @param {object} args.recipient    — { full_name, email }
 * @param {object} args.issuer       — { full_name }
 * @param {string} args.templateName — for the subject line
 */
export async function sendContractIssuedEmail({ contract, recipient, issuer, templateName }) {
  if (!recipient?.email) return { ok: false, error: 'No recipient email' }
  const branding = await getBranding(contract.location_id)
  const reviewUrl = `${appUrl()}/account/contracts/${contract.id}`
  const subject = `Action required: ${templateName || 'Your contract'} from UN1T`
  const innerHtml = `
    <h2 style="font-size:20px;margin:0 0 16px 0;">A contract is ready for your review</h2>
    <p>Hi ${escapeHtml(recipient.full_name || 'there')},</p>
    <p>${escapeHtml(issuer?.full_name || 'A UN1T administrator')} has issued you the
    following contract for review and signature:</p>
    <p style="background:#f9fafb;border-left:3px solid #111827;padding:12px 16px;margin:16px 0;font-weight:600;">
      ${escapeHtml(templateName || 'Contract')}
    </p>
    <p>Please open the link below to read the contract in full and add your
    signature. The contract has already been countersigned by
    ${escapeHtml(issuer?.full_name || 'the issuer')} — you'll see their typed signature
    on the document.</p>
    <p style="text-align:center;margin:28px 0;">
      <a href="${reviewUrl}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;">Review &amp; sign</a>
    </p>
    <p style="font-size:12px;color:#6b7280;">If the button doesn't work, copy this link into your browser:<br />
      <a href="${reviewUrl}" style="color:#6b7280;word-break:break-all;">${reviewUrl}</a></p>`
  try {
    await sendEmail({
      to: recipient.email,
      subject,
      htmlBody: emailShell(innerHtml, branding),
      stream: 'outbound',
      tag: 'contract-issued',
      metadata: { contract_id: contract.id, profile_id: contract.profile_id },
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e?.message || 'Postmark send failed' }
  }
}

/**
 * Nudge email for a contract still sitting at 'issued'/'viewed' with no
 * signature. Fired by the /api/cron/contract-reminders cron
 * (CONTRACTS-REMIND.1), capped at 2 reminders per contract — see
 * reminderDue() in contracts.js for the due-predicate. Mirrors
 * sendContractIssuedEmail's shell/branding exactly; only the copy and the
 * Postmark tag differ, and the link points at /account/contracts/<id>
 * (the recipient's own signing page) same as the issue email.
 *
 * @param {object} args
 * @param {object} args.contract     — row from contracts table
 * @param {object} args.recipient    — { full_name, email }
 * @param {string} args.templateName — for the subject line
 */
export async function sendContractReminderEmail({ contract, recipient, templateName }) {
  if (!recipient?.email) return { ok: false, error: 'No recipient email' }
  const branding = await getBranding(contract.location_id)
  const reviewUrl = `${appUrl()}/account/contracts/${contract.id}`
  const subject = `Reminder: ${templateName || 'Your contract'} is awaiting your signature`
  const innerHtml = `
    <h2 style="font-size:20px;margin:0 0 16px 0;">Your contract is still awaiting signature</h2>
    <p>Hi ${escapeHtml(recipient.full_name || 'there')},</p>
    <p>This is a reminder that the following contract is still waiting on your
    signature:</p>
    <p style="background:#f9fafb;border-left:3px solid #111827;padding:12px 16px;margin:16px 0;font-weight:600;">
      ${escapeHtml(templateName || 'Contract')}
    </p>
    <p>Please open the link below to read the contract in full and add your
    signature.</p>
    <p style="text-align:center;margin:28px 0;">
      <a href="${reviewUrl}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;">Review &amp; sign</a>
    </p>
    <p style="font-size:12px;color:#6b7280;">If the button doesn't work, copy this link into your browser:<br />
      <a href="${reviewUrl}" style="color:#6b7280;word-break:break-all;">${reviewUrl}</a></p>`
  try {
    await sendEmail({
      to: recipient.email,
      subject,
      htmlBody: emailShell(innerHtml, branding),
      stream: 'outbound',
      tag: 'contract-reminder',
      metadata: { contract_id: contract.id, profile_id: contract.profile_id },
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e?.message || 'Postmark send failed' }
  }
}

/**
 * Two emails after the recipient signs: the recipient gets a
 * "thanks, here's your copy" confirmation, and the issuer gets a
 * "Sarah signed her contract" notification. Both link to the
 * dual-signed document at /contracts/[id] (issuer) or
 * /account/contracts/[id] (recipient).
 *
 * CONTRACTS-PDF.1 — when the caller passes `pdfBuffer` (the dual-signed
 * PDF the sign route just generated and stored) BOTH emails carry it as
 * a `signed-contract.pdf` attachment, so each party has an offline copy
 * without logging back in. Omit it and behaviour is exactly as before.
 *
 * @param {Buffer|Uint8Array|null} [args.pdfBuffer] optional signed PDF
 */
export async function sendContractSignedEmails({ contract, recipient, issuer, templateName, pdfBuffer = null }) {
  const branding = await getBranding(contract.location_id)
  const recipientUrl = `${appUrl()}/account/contracts/${contract.id}`
  const issuerUrl = `${appUrl()}/contracts/${contract.id}`
  const results = { recipient: null, issuer: null }

  // Postmark's hard limit is 10MB for the WHOLE message including the
  // ~33% base64 inflation, so we gate the raw buffer well under it at
  // 8MB. Over that we send the email without the attachment rather than
  // losing the notification entirely: the signed contract is always
  // available in-app and via /api/contracts/<id>/pdf.
  let attachments
  if (pdfBuffer && pdfBuffer.length) {
    if (pdfBuffer.length > MAX_ATTACHMENT_BYTES) {
      results.warning = `Signed PDF was too large to attach (${(pdfBuffer.length / 1024 / 1024).toFixed(1)}MB); the emails link to it instead.`
    } else {
      attachments = [{
        Name: 'signed-contract.pdf',
        Content: Buffer.from(pdfBuffer).toString('base64'),
        ContentType: 'application/pdf',
      }]
    }
  }

  // 1. Recipient confirmation
  if (recipient?.email) {
    const subject = `Signed: ${templateName || 'Your contract'}`
    const innerHtml = `
      <h2 style="font-size:20px;margin:0 0 16px 0;">Your signed contract</h2>
      <p>Hi ${escapeHtml(recipient.full_name || 'there')},</p>
      <p>Thanks for signing <strong>${escapeHtml(templateName || 'your contract')}</strong>.
      A copy is stored in your UN1T account and a copy stays with us. You
      can re-open and print it any time:</p>
      <p style="text-align:center;margin:28px 0;">
        <a href="${recipientUrl}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;">View signed contract</a>
      </p>
      <p style="font-size:12px;color:#6b7280;">For your records, the contract was signed
      on ${formatFullDateTimeInTZ(contract.signed_at || new Date())}.</p>`
    try {
      await sendEmail({
        to: recipient.email,
        subject,
        htmlBody: emailShell(innerHtml, branding),
        stream: 'outbound',
        tag: 'contract-signed',
        metadata: { contract_id: contract.id, profile_id: contract.profile_id },
        attachments,
      })
      results.recipient = { ok: true }
    } catch (e) {
      results.recipient = { ok: false, error: e?.message || 'Send failed' }
    }
  }

  // 2. Issuer notification
  if (issuer?.email) {
    const subject = `${recipient?.full_name || 'A staff member'} signed: ${templateName || 'contract'}`
    const innerHtml = `
      <h2 style="font-size:20px;margin:0 0 16px 0;">Contract signed</h2>
      <p>Hi ${escapeHtml(issuer.full_name || 'there')},</p>
      <p><strong>${escapeHtml(recipient?.full_name || 'The recipient')}</strong> just
      signed the contract you issued:</p>
      <p style="background:#f9fafb;border-left:3px solid #10b981;padding:12px 16px;margin:16px 0;font-weight:600;">
        ${escapeHtml(templateName || 'Contract')}
      </p>
      <p style="text-align:center;margin:28px 0;">
        <a href="${issuerUrl}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;">View contract</a>
      </p>`
    try {
      await sendEmail({
        to: issuer.email,
        subject,
        htmlBody: emailShell(innerHtml, branding),
        stream: 'outbound',
        tag: 'contract-signed-issuer',
        metadata: { contract_id: contract.id, profile_id: contract.profile_id },
        attachments,
      })
      results.issuer = { ok: true }
    } catch (e) {
      results.issuer = { ok: false, error: e?.message || 'Send failed' }
    }
  }
  return results
}

/**
 * Notify the issuer when the recipient declines.
 */
export async function sendContractDeclinedEmail({ contract, recipient, issuer, templateName }) {
  if (!issuer?.email) return { ok: false, error: 'No issuer email' }
  const branding = await getBranding(contract.location_id)
  const issuerUrl = `${appUrl()}/contracts/${contract.id}`
  const subject = `Declined: ${recipient?.full_name || 'recipient'} — ${templateName || 'contract'}`
  const innerHtml = `
    <h2 style="font-size:20px;margin:0 0 16px 0;">Contract declined</h2>
    <p>Hi ${escapeHtml(issuer.full_name || 'there')},</p>
    <p><strong>${escapeHtml(recipient?.full_name || 'The recipient')}</strong> declined
    the contract you issued.</p>
    ${contract.declined_reason ? `
    <p style="background:#fef2f2;border-left:3px solid #dc2626;padding:12px 16px;margin:16px 0;">
      <strong>Reason:</strong> ${escapeHtml(contract.declined_reason)}
    </p>` : ''}
    <p style="text-align:center;margin:28px 0;">
      <a href="${issuerUrl}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;">View details</a>
    </p>`
  try {
    await sendEmail({
      to: issuer.email,
      subject,
      htmlBody: emailShell(innerHtml, branding),
      stream: 'outbound',
      tag: 'contract-declined',
      metadata: { contract_id: contract.id, profile_id: contract.profile_id },
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e?.message || 'Send failed' }
  }
}

/**
 * Notify the recipient when the issuer revokes a pending contract.
 */
export async function sendContractRevokedEmail({ contract, recipient, templateName }) {
  if (!recipient?.email) return { ok: false, error: 'No recipient email' }
  const branding = await getBranding(contract.location_id)
  const subject = `Contract withdrawn: ${templateName || 'previous contract'}`
  const innerHtml = `
    <h2 style="font-size:20px;margin:0 0 16px 0;">A contract has been withdrawn</h2>
    <p>Hi ${escapeHtml(recipient.full_name || 'there')},</p>
    <p>The contract you were sent (<em>${escapeHtml(templateName || 'previous contract')}</em>)
    has been withdrawn before signature.</p>
    ${contract.revoked_reason ? `
    <p style="background:#fef9c3;border-left:3px solid #ca8a04;padding:12px 16px;margin:16px 0;">
      <strong>Reason:</strong> ${escapeHtml(contract.revoked_reason)}
    </p>` : ''}
    <p>No action is required. If a replacement is needed, you'll receive a
    fresh contract email separately.</p>`
  try {
    await sendEmail({
      to: recipient.email,
      subject,
      htmlBody: emailShell(innerHtml, branding),
      stream: 'outbound',
      tag: 'contract-revoked',
      metadata: { contract_id: contract.id, profile_id: contract.profile_id },
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e?.message || 'Send failed' }
  }
}

// Tiny HTML escape — we never embed user-supplied HTML, but names
// and reasons can contain ampersands / angle brackets that would
// break the layout if not escaped.
function escapeHtml(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
