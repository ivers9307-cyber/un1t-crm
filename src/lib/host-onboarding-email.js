// Host onboarding email (EVENTS-HOST.9).
//
// Emails the self-serve Stripe onboarding link to an event host so the operator
// doesn't have to copy-paste it. Stripe-compliant: the email links to OUR
// token page (/host-connect/[token]), never the Stripe Account Link itself —
// the Account Link is only ever minted inside the host's page session. The
// token carries a 7-day TTL (EVENTS-HOST.6), reflected in the copy.

import { sendEmail } from './postmark'

const escapeHtml = (s) => String(s || '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
))

/**
 * Pure HTML builder — exported so tests can lock the link + escaping without
 * sending anything.
 * @param {{ hostName?: string, url: string }} args
 * @returns {string}
 */
export function renderHostOnboardingEmail({ hostName, url }) {
  const name = escapeHtml(hostName || 'there')
  const safeUrl = escapeHtml(url)
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
    <div style="background:#111827;padding:24px;text-align:center;">
      <span style="color:#ffffff;font-weight:700;letter-spacing:2px;font-size:18px;">UN1T</span>
    </div>
    <div style="padding:28px;">
      <p style="margin:0 0 12px;">Hi ${name},</p>
      <p style="margin:0 0 16px;line-height:1.6;">You're set up to host events with UN1T. Connect your Stripe account so your event ticket sales are paid directly to you.</p>
      <p style="text-align:center;margin:24px 0;">
        <a href="${safeUrl}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;">Connect your Stripe account</a>
      </p>
      <p style="margin:16px 0 0;font-size:13px;color:#6b7280;line-height:1.6;">This link is unique to you and expires in 7 days — if it stops working, ask UN1T for a fresh one. No login required.</p>
    </div>
  </div>
</body>
</html>`
}

/**
 * Build + send the host onboarding email. Caller has already minted `url`.
 * @param {{ host: { id: string, name?: string, email: string }, url: string }} args
 */
export async function sendHostOnboardingEmail({ host, url }) {
  const htmlBody = renderHostOnboardingEmail({ hostName: host?.name, url })
  return sendEmail({
    to: host.email,
    subject: 'Connect your Stripe account to get paid for your UN1T events',
    htmlBody,
    stream: 'outbound', // transactional, not broadcast
    tag: 'host-onboarding-link',
    metadata: { host_id: host.id },
  })
}
