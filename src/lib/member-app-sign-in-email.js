// Member-app sign-in prompt (APPINVITE.1).
//
// POST /api/contacts/[id]/invite-app, for a contact whose email already has a
// Supabase account, used to call admin.generateLink({ type: 'magiclink' }),
// throw the link away and tell staff "Sign-in link sent". generateLink only
// MINTS a link; Supabase sends nothing, so the member received no email.
//
// We do NOT email a server-minted link here, on purpose. The member app's web
// sign-in (champ-app /auth/callback) completes only a PKCE `?code=` link, and
// a PKCE link works only in the browser that requested it. An admin-minted
// link comes back as an implicit `#access_token` fragment the callback cannot
// read (it lands on /login?error=missing_code), and a server-side
// signInWithOtp would park the PKCE verifier on OUR server. So the member gets
// a short email pointing at the app's sign-in page, where they request their
// own link in their own browser. No credential travels in this email.
//
// Copy is operator-editable per the standing rule: an email_templates row at
// the contact's location named MEMBER_APP_SIGN_IN_TEMPLATE wins over the
// built-in default. Both support {{first_name}}, {{sign_in_url}}, {{app_name}},
// {{company_name}} (the location's brand), {{short_name}} (the short brand,
// "the UN1T app") and {{studio}}. Token values are HTML-escaped in the body.

import { sendTransactionalEmail } from './postmark'
import { getLocationBranding } from './location-branding'
import { applyTokens } from './offer-purchase-emails'

export const MEMBER_APP_SIGN_IN_TEMPLATE = 'member-app-sign-in'

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
))

function wrapBody(bodyHtml) {
  return `<div style="font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;">${bodyHtml}</div>`
}

/**
 * Built-in copy, written with {{tokens}} so the default and an operator
 * override go through the same substitution. Plain and low-key: no
 * em-dashes, no emoji.
 */
export function defaultMemberAppSignInCopy() {
  return {
    subject: 'Sign in to the {{app_name}}',
    htmlBody: wrapBody(
      '<p>Hi {{first_name}},</p>' +
      '<p>Your account for the {{app_name}} is ready. To sign in, open the link below and enter this email address. We will send you a sign-in link straight away.</p>' +
      '<p><a href="{{sign_in_url}}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;">Sign in</a></p>' +
      '<p>If you weren\'t expecting this, you can ignore it.</p>' +
      '<p>{{studio}}</p>'
    ),
  }
}

/** Pure. The tokens for one contact at one location. */
export function memberAppSignInTokens({ contact, branding, locationName, signInUrl }) {
  const first = String(contact?.first_name || contact?.name || '').trim().split(/\s+/)[0]
  const shortName = branding?.shortName || ''
  return {
    first_name: first || 'there',
    sign_in_url: signInUrl,
    company_name: branding?.companyName || '',
    short_name: shortName,
    // "the UN1T app"; an unknown brand reads "the app", never another gym's.
    app_name: shortName ? `${shortName} app` : 'app',
    studio: locationName || branding?.companyName || '',
  }
}

/** Pure. Substitute tokens: escaped in the HTML body, raw in the subject. */
export function renderMemberAppSignInEmail(template, tokens) {
  const escaped = Object.fromEntries(Object.entries(tokens).map(([k, v]) => [k, escapeHtml(v)]))
  return {
    subject: applyTokens(template.subject, tokens),
    htmlBody: applyTokens(template.htmlBody, escaped),
  }
}

/**
 * Brand + send the sign-in prompt. Throws on a Postmark rejection
 * (sendTransactionalEmail's contract), so the caller can refuse to report
 * success.
 * @param {object} db  service-role client
 * @param {{ contact: { id: string, email: string, name?: string, location_id: string }, signInUrl: string }} args
 */
export async function sendMemberAppSignInEmail(db, { contact, signInUrl }) {
  const locationId = contact.location_id
  const branding = await getLocationBranding(db, locationId)
  const { data: loc } = await db
    .from('locations')
    .select('name')
    .eq('id', locationId)
    .maybeSingle()
  // Operator override wins over the built-in copy. A failed read falls back
  // to the default rather than losing the email.
  const { data: tpl } = await db
    .from('email_templates')
    .select('subject, html_content')
    .eq('location_id', locationId)
    .eq('name', MEMBER_APP_SIGN_IN_TEMPLATE)
    .maybeSingle()

  const fallback = defaultMemberAppSignInCopy()
  const template = tpl?.html_content
    ? { subject: tpl.subject || fallback.subject, htmlBody: tpl.html_content }
    : fallback
  const tokens = memberAppSignInTokens({ contact, branding, locationName: loc?.name, signInUrl })
  const { subject, htmlBody } = renderMemberAppSignInEmail(template, tokens)

  return sendTransactionalEmail({
    to: contact.email,
    subject,
    htmlBody,
    contactId: contact.id,
    locationId,
    tag: 'member-app-sign-in',
  })
}
