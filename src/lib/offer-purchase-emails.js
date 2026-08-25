// offer-purchase-emails.js — the buyer-facing side of a sale purchase
// (OFFERS.11). Until this existed a buyer got a Revolut receipt and nothing
// from us: no confirmation of WHAT they bought, no word on when it would be
// usable. Staff got an ops alert; the customer got silence.
//
// Two transactional messages, deliberately separate because fulfilment is
// manual (staff set the member up in Glofox):
//   'paid'  — sent the moment the payment settles. Says what they bought and
//             that it will be on their account within 24 hours. It must NOT
//             claim the purchase is usable yet, because it is not.
//   'ready' — sent when staff mark the purchase fulfilled. THIS is the one
//             that says it is on their account and they can book.
//
// TRANSACTIONAL, not marketing: someone who just paid us gets their
// confirmation whether or not they are on a marketing list. Gates mirror
// booking-confirmations.js exactly — hard-stop on bounced/complained, honour
// the email_administrative opt-out, and deliberately ignore 'unsubscribed'
// (LOCCOMMS.5).
//
// Copy is operator-editable per the standing rule: if an email_templates row
// exists at the location under the name below, it wins; otherwise the
// built-in default is used. Both support {{first_name}}, {{offer_name}},
// {{bonus}}, {{amount}} and {{studio}}.

import { sendTransactionalEmail } from './postmark'
import { formatEuro } from './sale-offers'

export const PURCHASE_EMAIL_TEMPLATES = Object.freeze({
  paid: 'offer-purchase-paid',
  ready: 'offer-purchase-ready',
})

/**
 * Turn a bonus headline ("+2 WEEKS FREE", "+10 CLASSES FREE") into prose
 * ("2 extra weeks", "10 extra classes"). Returns '' for anything unparseable
 * so the copy degrades to not mentioning the bonus rather than printing
 * marketing shout-caps mid-sentence.
 */
export function bonusPhrase(headline) {
  // (?:e?s)? covers the three plurals in play: week/weeks, month/months and
  // CLASSES — a bare `s?` leaves the trailing "E" and the \b never matches.
  const m = /^\s*\+?\s*(\d+)\s+(week|month|class|session)(?:e?s)?\b/i.exec(String(headline || ''))
  if (!m) return ''
  const n = Number(m[1])
  const unit = m[2].toLowerCase()
  if (n === 1) return `${n} extra ${unit}`
  // 'class' pluralises to 'classes', not 'classs'.
  return `${n} extra ${unit === 'class' ? 'classes' : `${unit}s`}`
}

/** Replace the supported {{tokens}}. Unknown tokens are left untouched. */
export function applyTokens(text, tokens) {
  return String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(tokens, key) ? String(tokens[key] ?? '') : whole
  )
}

function wrapBody(bodyHtml) {
  return `<div style="font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;">${bodyHtml}</div>`
}

/**
 * Built-in copy. Plain and low-key on purpose: this is a receipt, not a
 * campaign. No em-dashes, no emoji.
 */
export function defaultCopy(kind, tokens) {
  const bonusLine = tokens.bonus ? `, with ${tokens.bonus} included` : ''

  // GIFTCARD.1 — a gift card buyer is usually NOT the person who will train,
  // so the membership copy ("book classes through the app") is wrong for
  // them in both directions: it tells the wrong person to book, and it says
  // nothing about handing the card over. The 5-year validity is repeated
  // here because the email is the buyer's record of the purchase.
  if (tokens.category === 'gift_card') {
    if (kind === 'paid') {
      return {
        subject: `Payment received: ${tokens.offer_name}`,
        htmlBody: wrapBody(
          `<p>Hi ${tokens.first_name},</p>` +
          `<p>Thanks for buying a <strong>${tokens.offer_name}</strong>. We have your payment of ${tokens.amount}.</p>` +
          `<p>We will have it ready within 24 hours and will email you everything you need to hand it over. Nothing else for you to do.</p>` +
          `<p>If anything looks wrong, just reply to this email.</p>` +
          `<p>${tokens.studio}</p>`
        ),
      }
    }
    return {
      subject: `Your ${tokens.offer_name} is ready`,
      htmlBody: wrapBody(
        `<p>Hi ${tokens.first_name},</p>` +
        `<p>Your <strong>${tokens.offer_name}</strong> is ready to hand over.</p>` +
        `<p>It is valid for 5 years and can be used against any membership, class pack or drop-in at ${tokens.studio}. Whoever you are giving it to just needs to mention it at reception and we will take it from there.</p>` +
        `<p>Any questions, reply to this email.</p>` +
        `<p>${tokens.studio}</p>`
      ),
    }
  }

  if (kind === 'paid') {
    return {
      subject: `Payment received: ${tokens.offer_name}`,
      htmlBody: wrapBody(
        `<p>Hi ${tokens.first_name},</p>` +
        `<p>Thanks for grabbing the <strong>${tokens.offer_name}</strong>${bonusLine}. We have your payment of ${tokens.amount}.</p>` +
        `<p>We will have it set up on your account within 24 hours and will email you the moment it is live. Nothing else for you to do.</p>` +
        `<p>If anything looks wrong, just reply to this email.</p>` +
        `<p>${tokens.studio}</p>`
      ),
    }
  }
  return {
    subject: `You're all set: ${tokens.offer_name}`,
    htmlBody: wrapBody(
      `<p>Hi ${tokens.first_name},</p>` +
      `<p>Your <strong>${tokens.offer_name}</strong>${bonusLine} is now on your account and ready to use.</p>` +
      `<p>Book classes through the UN1T app the way you normally would and you are good to go.</p>` +
      `<p>If anything looks off when you go to book, just reply to this email and we will sort it.</p>` +
      `<p>See you in the studio.</p>` +
      `<p>${tokens.studio}</p>`
    ),
  }
}

/**
 * Send one purchase email.
 *
 * @param {object} db        service-role client
 * @param {object} purchase  offer_purchases row (needs contact_id, buyer_*, location_id, amount_cents)
 * @param {object} offer     sale_offers row (name, bonus_headline)
 * @param {'paid'|'ready'} kind
 * @returns {Promise<{status:'sent'|'skipped', reason?:string}>}
 */
export async function sendOfferPurchaseEmail(db, { purchase, offer, kind = 'ready' } = {}) {
  const to = purchase?.buyer_email
  if (!to) return { status: 'skipped', reason: 'no_email_address' }

  // Consent + deliverability gates, only knowable via the linked contact.
  let contact = null
  if (purchase.contact_id) {
    const { data } = await db
      .from('contacts')
      .select('id, first_name, name, email_status, contact_preferences ( email_administrative )')
      .eq('id', purchase.contact_id)
      .maybeSingle()
    contact = data || null
  }
  if (contact?.email_status && ['bounced', 'complained'].includes(contact.email_status)) {
    return { status: 'skipped', reason: `email_status=${contact.email_status}` }
  }
  const prefs = contact?.contact_preferences
  const adminConsent = Array.isArray(prefs) ? prefs[0]?.email_administrative : prefs?.email_administrative
  if (adminConsent === false) {
    return { status: 'skipped', reason: 'opted_out_administrative_email' }
  }

  const { data: loc } = await db
    .from('locations')
    .select('name')
    .eq('id', purchase.location_id)
    .maybeSingle()

  const tokens = {
    first_name: (contact?.first_name || purchase.buyer_name || '').split(' ')[0] || 'there',
    offer_name: offer?.name || 'your purchase',
    category: offer?.category || null,
    bonus: bonusPhrase(offer?.bonus_headline),
    amount: formatEuro(purchase.amount_cents || 0),
    studio: loc?.name || 'UN1T',
  }

  // Operator override wins over the built-in copy.
  const { data: tpl } = await db
    .from('email_templates')
    .select('subject, html_content')
    .eq('location_id', purchase.location_id)
    .eq('name', PURCHASE_EMAIL_TEMPLATES[kind] || PURCHASE_EMAIL_TEMPLATES.ready)
    .maybeSingle()

  const base = tpl?.html_content
    ? { subject: tpl.subject || defaultCopy(kind, tokens).subject, htmlBody: tpl.html_content }
    : defaultCopy(kind, tokens)

  await sendTransactionalEmail({
    to,
    subject: applyTokens(base.subject, tokens),
    htmlBody: applyTokens(base.htmlBody, tokens),
    contactId: purchase.contact_id || null,
    locationId: purchase.location_id,
    tag: `offer-purchase-${kind}`,
  })

  return { status: 'sent' }
}
