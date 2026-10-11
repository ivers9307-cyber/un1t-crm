// Host onboarding email (EVENTS-HOST.9).
//
// Emails the self-serve Stripe onboarding link to an event host so the operator
// doesn't have to copy-paste it. Stripe-compliant: the email links to OUR
// token page (/host-connect/[token]), never the Stripe Account Link itself —
// the Account Link is only ever minted inside the host's page session. The
// token carries a 7-day TTL (EVENTS-HOST.6), reflected in the copy.
//
// W1.S1c: the email speaks for the host's ORGANISATION (resolveHostOrgBrand:
// org brand in the sentences and subject, its short name as the header
// wordmark), never a literal gym; it floors on the platform name.

import { sendEmail } from './postmark'
import { PLATFORM_NAME } from './brand-name'
import { createServerClient } from './supabase'
import { resolveHostOrgBrand } from './host-org-brand'

const escapeHtml = (s) => String(s || '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
))

/**
 * Pure HTML builder — exported so tests can lock the link + escaping without
 * sending anything.
 * @param {{ hostName?: string, url: string, brand?: { name?: string, shortName?: string }|null }} args
 * @returns {string}
 */
export function renderHostOnboardingEmail({ hostName, url, brand = null }) {
  const name = escapeHtml(hostName || 'there')
  const brandName = escapeHtml(brand?.name || brand?.shortName || PLATFORM_NAME)
  const wordmark = escapeHtml(brand?.shortName || brand?.name || PLATFORM_NAME)
  const safeUrl = escapeHtml(url)
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
    <div style="background:#111827;padding:24px;text-align:center;">
      <span style="color:#ffffff;font-weight:700;letter-spacing:2px;font-size:18px;">${wordmark}</span>
    </div>
    <div style="padding:28px;">
      <p style="margin:0 0 12px;">Hi ${name},</p>
      <p style="margin:0 0 16px;line-height:1.6;">You're set up to host events with ${brandName}. Connect your Stripe account so your event ticket sales are paid directly to you.</p>
      <p style="text-align:center;margin:24px 0;">
        <a href="${safeUrl}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;">Connect your Stripe account</a>
      </p>
      <p style="margin:16px 0 0;font-size:13px;color:#6b7280;line-height:1.6;">This link is unique to you and expires in 7 days. If it stops working, ask ${brandName} for a fresh one. No login required.</p>
    </div>
  </div>
</body>
</html>`
}

/** Pure. The subject line, for the host's organisation brand. */
export function hostOnboardingSubject(brand = null) {
  return `Connect your Stripe account to get paid for your ${brand?.name || brand?.shortName || PLATFORM_NAME} events`
}

/**
 * Build + send the host onboarding email. Caller has already minted `url`.
 * @param {{ host: { id: string, name?: string, email: string, organization_id?: string }, url: string, db?: object|null }} args
 */
export async function sendHostOnboardingEmail({ host, url, db = null }) {
  const brand = await resolveHostOrgBrand(db || createServerClient(), host)
  const htmlBody = renderHostOnboardingEmail({ hostName: host?.name, url, brand })
  return sendEmail({
    to: host.email,
    subject: hostOnboardingSubject(brand),
    htmlBody,
    stream: 'outbound', // transactional, not broadcast
    tag: 'host-onboarding-link',
    metadata: { host_id: host.id },
  })
}
