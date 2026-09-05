// MOBILE-COMPOSER.1 — mobile data helpers for the contact message
// composer.
//
// The window-state + template logic is server-side (it reuses the
// radar-outreach helpers), so the app just fetches the composer
// context and posts a send — no web-side libraries on the device.

import { api } from './api'

/**
 * The composer context for a contact: the WhatsApp 24h window state
 * and the approved utility templates.
 *
 * @returns {Promise<{success, data?: { whatsapp: { windowOpen, windowExpiresAt }, templates: object[] }, error?}>}
 */
export function getMessagingContext(contactId) {
  return api(`/api/contacts/${contactId}/messaging`)
}

/**
 * Send a WhatsApp message to a contact. Pass { text } for free text
 * (only delivers inside the open 24h window) or { templateName } for
 * an approved utility template (delivers anytime).
 */
export function sendContactWhatsApp(contactId, { text, templateName } = {}) {
  const body = templateName ? { template_name: templateName } : { text }
  return api(`/api/contacts/${contactId}/whatsapp`, { method: 'POST', body })
}

/**
 * MOBILE-CONTACT-SEND.1 — send an SMS to a contact via the company
 * Twilio sender (not the phone's Messages app). The route gates on the
 * web `sms` OR mobile `sms` permission and rejects opted-out numbers.
 */
export function sendContactSms(contactId, { body } = {}) {
  return api(`/api/contacts/${contactId}/sms`, { method: 'POST', body: { body } })
}

/**
 * MOBILE-CONTACT-SEND.1 — send a one-off transactional email to a
 * contact via the company Postmark sender (not the phone's Mail app).
 * The route gates on the web `email` OR mobile `email` permission and
 * rejects bounced / complained / unsubscribed addresses.
 */
export function sendContactEmail(contactId, { subject, body } = {}) {
  return api(`/api/contacts/${contactId}/email`, { method: 'POST', body: { subject, body } })
}

/**
 * CANCEL-FORM.6 — send the member a single-use membership cancellation form
 * link by 'email' or 'whatsapp' (staff action). The route mints the link,
 * delivers it and logs the send; a closed WhatsApp window with no approved
 * template answers 409 { window_expired, needs_template }.
 */
export function sendCancellationForm(contactId, { channel } = {}) {
  return api(`/api/contacts/${contactId}/cancellation-form`, { method: 'POST', body: { channel } })
}
