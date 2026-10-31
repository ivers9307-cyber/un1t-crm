// Best-effort WhatsApp booking confirmation for campaign booking pages
// (/start). Sent as a UTILITY template (no 24h window after a web booking),
// straight to the lead's normalised phone, then wa_phone is backfilled so
// the message logs to a conversation and any reply routes to Mia. Never throws.

import { contactWhatsAppNumber } from '@/lib/phone-validate'
import { sendTemplateMessage, getOrCreateConversation } from '@/lib/whatsapp'
import { logTransactionalWalletState } from '@/lib/wallet-enforcement'
import { logWarn } from '@/lib/log'
import { isFeatureEnabledAtLocation } from '@shared/permissions'
import { PURPOSES, resolvePurposeTemplate } from '@/lib/whatsapp-purpose-templates'

// Today's template names, now the FALLBACKS of the per-studio purpose templates
// (WAORGNUMBER.2 R5, src/lib/whatsapp-purpose-templates.js): a studio picks its
// own template per purpose, and only a studio that has not picked one uses the
// name. NOTE: the class template was created with a TRAILING UNDERSCORE
// ('booking_class_confirmed_'); the lookup is exact, so the name must match the
// live one.
export const CONSULT_CONFIRM_TEMPLATE = PURPOSES.consult_confirmed.fallbackName
export const CLASS_CONFIRM_TEMPLATE = PURPOSES.class_confirmed.fallbackName

/**
 * `purpose` (class_confirmed | consult_confirmed | event_waitlist_offer): the
 * studio's own template for that purpose (resolvePurposeTemplate), else the
 * purpose's default name at the studio; none → a quiet `template_not_found`.
 * `templateName` alone sends that exact template at the studio (an event
 * type's own confirmation, picked by id and passed by name).
 */
export async function maybeSendBookingWhatsappConfirm({ db, locationId, contact, templateName, purpose, bodyParams = [] }) {
  try {
    // TENANT.8 (item 3b) — location bundle/feature gate, before any send
    // work. Genuinely new query here (this helper never fetched a
    // `locations` row before) — accepted, this fires once per booking
    // confirmation, not a fan-out. Fail-open on a DB error, same posture
    // as this whole function's outer try/catch (never blocks a booking
    // confirmation on an unrelated read failing).
    let location = null
    try {
      const { data } = await db.from('locations').select('id, features').eq('id', locationId).maybeSingle()
      location = data
    } catch (e) { logWarn('booking-wa-confirm', 'location features read failed; defaulting open', { err: e }) }
    if (!isFeatureEnabledAtLocation(location, 'whatsapp')) {
      return { sent: false, reason: 'bundle_disabled' }
    }

    if (!templateName && !purpose) return { sent: false, reason: 'no_template_configured' }
    if (!contact?.phone && !contact?.wa_phone) return { sent: false, reason: 'no_phone' }

    // WAPHONE.1 — the contact's WhatsApp number (a stored wa_phone, else the
    // phone through the one rule the contacts trigger also uses). The Irish
    // formatter used before passed a landline or a bare 9-digit non-mobile
    // through as '+353…', which was then sent to and stored as wa_phone.
    const waPhone = contactWhatsAppNumber(contact)
    if (!waPhone) return { sent: false, reason: 'unnormalisable_phone' }

    let template
    if (purpose) {
      // Already the studio's APPROVED template, or null.
      template = await resolvePurposeTemplate(db, locationId, purpose, templateName ? { fallbackName: templateName } : {})
      if (!template) return { sent: false, reason: 'template_not_found' }
    } else {
      const { data } = await db
        .from('whatsapp_templates').select('*')
        .eq('name', templateName).eq('location_id', locationId).maybeSingle()
      template = data
      if (!template) return { sent: false, reason: 'template_not_found' }
      if (template.status !== 'APPROVED') return { sent: false, reason: `template_${template.status}` }
    }

    const components = [{
      type: 'body',
      parameters: bodyParams.map((v) => ({ type: 'text', text: (v == null || v === '') ? ' ' : String(v) })),
    }]

    // INTEG-C3 — booking confirmations are TRANSACTIONAL: never blocked
    // by billing, log-only (loud at/below the −€10 grace floor).
    // Fire-and-forget; the helper never rejects.
    logTransactionalWalletState(db, locationId, 'wa_template_send')

    // WAORGNUMBER.2 (R5) — the studio's number on the template's own WABA.
    const result = await sendTemplateMessage(waPhone, template.name, template.language || 'en', components, { locationId, ...(template.business_account_id && { businessAccountId: template.business_account_id }) })

    if (!contact.wa_phone) {
      try {
        const { error: waErr } = await db.from('contacts').update({ wa_phone: waPhone }).eq('id', contact.id).is('wa_phone', null)
        if (waErr) logWarn('booking-wa-confirm', 'wa_phone backfill failed', { err: waErr })
      } catch (e) { logWarn('booking-wa-confirm', 'wa_phone backfill failed', { err: e }) }
      contact = { ...contact, wa_phone: waPhone }
    }
    try {
      const conversationId = await getOrCreateConversation(db, contact, locationId)
      if (conversationId && result?.messageId) {
        await db.from('whatsapp_messages').insert({
          conversation_id: conversationId, contact_id: contact.id, location_id: locationId,
          wa_message_id: result.messageId, direction: 'outbound', message_type: 'template',
          template_name: template.name, body: bodyParams.join(' · '),
          status: 'sent', sent_at: new Date().toISOString(),
        })
      }
    } catch (e) { logWarn('booking-wa-confirm', 'inbox log failed', { err: e }) }

    return { sent: true, messageId: result?.messageId || null }
  } catch (e) {
    logWarn('booking-wa-confirm', 'send failed', { err: e })
    return { sent: false, reason: 'send_failed' }
  }
}
