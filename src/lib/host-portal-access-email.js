// Host-portal access email (HOST-PORTAL re-invite).
//
// POST /api/hosts/[id]/invite resends a set-password link to a host login that
// already exists. Supabase's admin generateLink only MINTS that link; it sends
// nothing. Before this module the route discarded the link and reported
// "invite re-sent" while the host received no email at all. The route now
// hands the generated action link here and only reports success once Postmark
// accepts the message.
//
// The link is a bearer credential (it signs the host in): it goes into the
// email body and nowhere else. Never log it, never put it in metadata.
//
// Brand (W1.S1c, as host-onboarding-email.js): the host's ORGANISATION via
// resolveHostOrgBrand, its brand name in the sentences and subject and its
// short name as the header wordmark, floored on PLATFORM_NAME.

import { sendEmail } from './postmark'
import { PLATFORM_NAME } from './brand-name'
import { resolveHostOrgBrand } from './host-org-brand'

const escapeHtml = (s) => String(s || '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
))

/**
 * Pure HTML builder, exported so tests can lock the link + escaping without
 * sending anything.
 * @param {{ url: string, brand?: { name?: string, shortName?: string }|null }} args
 * @returns {string}
 */
export function renderHostPortalAccessEmail({ url, brand: orgBrand = null }) {
  const brand = escapeHtml(orgBrand?.name || orgBrand?.shortName || PLATFORM_NAME)
  const wordmark = escapeHtml(orgBrand?.shortName || orgBrand?.name || PLATFORM_NAME)
  const safeUrl = escapeHtml(url)
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
    <div style="background:#111827;padding:24px;text-align:center;">
      <span style="color:#ffffff;font-weight:700;letter-spacing:2px;font-size:18px;">${wordmark}</span>
    </div>
    <div style="padding:28px;">
      <p style="margin:0 0 12px;">Hi there,</p>
      <p style="margin:0 0 16px;line-height:1.6;">Here is a link to set your password and sign in to your ${brand} host portal.</p>
      <p style="text-align:center;margin:24px 0;">
        <a href="${safeUrl}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;">Set your password</a>
      </p>
      <p style="margin:16px 0 0;font-size:13px;color:#6b7280;line-height:1.6;">This link is unique to you and works once. If it has expired, ask ${brand} for a new one. If you weren't expecting this email, you can ignore it.</p>
    </div>
  </div>
</body>
</html>`
}

/** Pure. The subject line, for the host's organisation brand. */
export function hostPortalAccessSubject(brand = null) {
  return `Set your password for the ${brand?.name || brand?.shortName || PLATFORM_NAME} host portal`
}

/**
 * Brand + send the host-portal set-password email. Caller has already minted
 * `url` (the Supabase action link). Throws on a Postmark rejection (sendEmail's
 * contract), so the caller can refuse to report success.
 * @param {{ db: object, host: { id: string, organization_id?: string }, to: string, url: string }} args
 */
export async function sendHostPortalAccessEmail({ db, host, to, url }) {
  const brand = await resolveHostOrgBrand(db, host)
  return sendEmail({
    to,
    subject: hostPortalAccessSubject(brand),
    htmlBody: renderHostPortalAccessEmail({ url, brand }),
    stream: 'outbound', // transactional, not broadcast
    tag: 'host-portal-access',
    metadata: { host_id: host.id },
  })
}
