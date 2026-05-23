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
