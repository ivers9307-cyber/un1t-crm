// CORPPROMO.1 — the /corp confirmation email: the promo's credits are on the
// person's un1t.online account, and by when to use them. The words are the
// studio's corp_promo block (corpPromoCopyFromBlocks); the operator's text is
// trusted, the token values are escaped. Transactional, so it honours the
// administrative opt-out and a bounced/complained address, never marketing.
import { sendTransactionalEmail } from '@/lib/postmark'
import { escapeHtml } from '@/lib/html-escape'
import { fillCorpPromoTokens } from '@/lib/corp-promos'
import { formatInZone } from '@/lib/location-time'
import { renderAppSection } from '@/lib/un1t-online-app-links'

/** "Tuesday 4 November" in the studio's zone; null for an unreadable instant. */
export function expiresOnLabel(expiresAt, zone) {
  const ms = Date.parse(expiresAt ?? '')
  if (!Number.isFinite(ms)) return null
  return formatInZone(new Date(ms), zone, { weekday: 'long', day: 'numeric', month: 'long' })
}

/** The tokens every /corp text may use. */
export function corpPromoTokens({ firstName, credits, expiresAt, zone, studioName }) {
  return {
    first_name: (firstName || '').trim().split(/\s+/)[0] || 'there',
    credits: String(credits ?? ''),
    expires_on: expiresOnLabel(expiresAt, zone) ?? 'the end of the week',
    studio_name: studioName || '',
  }
}

const paragraphs = (text) => text.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br/>')}</p>`).join('')

/**
 * @param {object} db service-role client
 * @param {{ claim: object, copy: object, studioName: string, zone: string, appLinks?: object|null }} args
 *   appLinks: the studio's app download links (UN1TWELCOME); the section follows the body, left out when there are none
 *   claim: a corp_promo_claims row with credits and expires_at stamped
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
export async function sendCorpPromoEmail(db, { claim, copy, studioName, zone, appLinks = null }) {
  const to = claim?.customer_email
  if (!to) return { sent: false, reason: 'no_email_address' }
  if (claim.contact_id) {
    const { data: contact, error } = await db.from('contacts')
      .select('id, email_status, contact_preferences ( email_administrative )')
      .eq('id', claim.contact_id).maybeSingle()
    if (error) return { sent: false, reason: 'contact_unreadable' }
    if (contact?.email_status && ['bounced', 'complained'].includes(contact.email_status)) return { sent: false, reason: `email_status=${contact.email_status}` }
    const prefs = contact?.contact_preferences
    const adminConsent = Array.isArray(prefs) ? prefs[0]?.email_administrative : prefs?.email_administrative
    if (adminConsent === false) return { sent: false, reason: 'opted_out_administrative_email' }
  }
  const tokens = corpPromoTokens({ firstName: claim.first_name, credits: claim.credits, expiresAt: claim.expires_at, zone, studioName })
  const safe = Object.fromEntries(Object.entries(tokens).map(([k, v]) => [k, escapeHtml(v)]))
  const appSection = renderAppSection(appLinks)
  await sendTransactionalEmail({
    to,
    subject: fillCorpPromoTokens(copy.email_subject, tokens),
    // The block is plain text: escaped whole, then filled with escaped tokens.
    htmlBody: paragraphs(fillCorpPromoTokens(escapeHtml(copy.email_body), safe)) + (appSection ? `\n<div style="font-family:Arial,Helvetica,sans-serif;margin-top:16px">${appSection}</div>` : ''),
    contactId: claim.contact_id || null,
    locationId: claim.location_id,
    tag: 'corp-promo-granted',
  })
  return { sent: true }
}
