// PAIDTRIAL.1 — the buyer's confirmation once the Glofox plan is on their
// account. One message, transactional: someone who just paid gets it whether
// or not they are on a marketing list. Gates mirror offer-purchase-emails.js:
// hard-stop on bounced/complained, honour the email_administrative opt-out.
// Copy is operator-editable: an email_templates row at the location named
// `trial-purchase-granted` wins; otherwise the built-in default. Tokens:
// {{first_name}}, {{product_name}}, {{duration_days}}, {{amount}}, {{studio}},
// {{company_name}}, {{short_name}}.
import { sendTransactionalEmail } from './postmark'
import { getLocationBranding } from './location-branding'
import { applyTokens } from './offer-purchase-emails'
import { formatTrialPrice } from './paid-trial'

export const TRIAL_PURCHASE_EMAIL_TEMPLATES = Object.freeze({ granted: 'trial-purchase-granted' })

function wrapBody(bodyHtml) {
  return `<div style="font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;">${bodyHtml}</div>`
}

export function defaultTrialCopy(kind, tokens) {
  return {
    subject: `You're all set: ${tokens.product_name}`,
    htmlBody: wrapBody(
      `<p>Hi ${tokens.first_name},</p>` +
      `<p>Thanks for buying the <strong>${tokens.product_name}</strong>. We have your payment of ${tokens.amount}, and the trial is now on your account.</p>` +
      `<p>Book classes through the ${tokens.short_name ? `${tokens.short_name} app` : 'app'} the way members do: your ${tokens.duration_days} days run from your first class.</p>` +
      `<p>If anything looks off when you go to book, just reply to this email and we will sort it.</p>` +
      `<p>See you in the studio.</p>` +
      `<p>${tokens.studio}</p>`
    ),
  }
}

/**
 * @param {object} db
 * @param {{ purchase: object, kind?: 'granted' }} args  trial_purchases row
 * @returns {Promise<{status:'sent'|'skipped', reason?:string}>}
 */
export async function sendTrialPurchaseEmail(db, { purchase, kind = 'granted' } = {}) {
  const to = purchase?.customer_email
  if (!to) return { status: 'skipped', reason: 'no_email_address' }
  let contact = null
  if (purchase.contact_id) {
    const { data } = await db.from('contacts')
      .select('id, first_name, name, email_status, contact_preferences ( email_administrative )')
      .eq('id', purchase.contact_id).maybeSingle()
    contact = data || null
  }
  if (contact?.email_status && ['bounced', 'complained'].includes(contact.email_status)) {
    return { status: 'skipped', reason: `email_status=${contact.email_status}` }
  }
  const prefs = contact?.contact_preferences
  const adminConsent = Array.isArray(prefs) ? prefs[0]?.email_administrative : prefs?.email_administrative
  if (adminConsent === false) return { status: 'skipped', reason: 'opted_out_administrative_email' }

  const { data: loc } = await db.from('locations').select('name').eq('id', purchase.location_id).maybeSingle()
  const branding = await getLocationBranding(db, purchase.location_id)
  const tokens = {
    first_name: (contact?.first_name || purchase.first_name || purchase.customer_name || '').split(' ')[0] || 'there',
    product_name: purchase.product_name || 'your trial',
    duration_days: String(purchase.duration_days || 14),
    amount: formatTrialPrice(purchase.amount_cents || 0, purchase.currency || 'EUR'),
    studio: loc?.name || branding.companyName || '',
    company_name: branding.companyName || '',
    short_name: branding.shortName || '',
  }
  const { data: tpl } = await db.from('email_templates')
    .select('subject, html_content')
    .eq('location_id', purchase.location_id)
    .eq('name', TRIAL_PURCHASE_EMAIL_TEMPLATES[kind] || TRIAL_PURCHASE_EMAIL_TEMPLATES.granted)
    .maybeSingle()
  const base = tpl?.html_content
    ? { subject: tpl.subject || defaultTrialCopy(kind, tokens).subject, htmlBody: tpl.html_content }
    : defaultTrialCopy(kind, tokens)
  await sendTransactionalEmail({
    to,
    subject: applyTokens(base.subject, tokens),
    htmlBody: applyTokens(base.htmlBody, tokens),
    contactId: purchase.contact_id || null,
    locationId: purchase.location_id,
    tag: `trial-purchase-${kind}`,
  })
  return { status: 'sent' }
}
