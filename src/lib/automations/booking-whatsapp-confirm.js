// Best-effort WhatsApp booking confirmation for campaign booking pages
// (/start). Sent as a UTILITY template (no 24h window after a web booking),
// straight to the lead's normalised phone, then wa_phone is backfilled so
// the message logs to a conversation and any reply routes to Mia. Mirrors
// the send pattern in meta-ad-whatsapp-welcome.js. Never throws.

import { toE164Ireland } from '@/lib/twilio'
import { sendTemplateMessage, getOrCreateConversation } from '@/lib/whatsapp'
import { logTransactionalWalletState } from '@/lib/wallet-enforcement'
import { logWarn } from '@/lib/log'
import { isFeatureEnabledAtLocation } from '@shared/permissions'

// Live APPROVED template names (single source of truth — keep in sync with the
// templates in WhatsApp Manager). NOTE: the class template was created with a
// TRAILING UNDERSCORE ('booking_class_confirmed_'); the lookup below is exact,
// so the code must match the live name. If the operator recreates a clean
// 'booking_class_confirmed', update this one constant.
export const CONSULT_CONFIRM_TEMPLATE = 'booking_consult_confirmed'
export const CLASS_CONFIRM_TEMPLATE = 'booking_class_confirmed_'

export async function maybeSendBookingWhatsappConfirm({ db, locationId, contact, templateName, bodyParams = [] }) {
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

    if (!templateName) return { sent: false, reason: 'no_template_configured' }
    if (!contact?.phone) return { sent: false, reason: 'no_phone' }

    const waPhone = toE164Ireland(contact.phone)
    if (!waPhone || !/^\+\d{10,15}$/.test(waPhone)) return { sent: false, reason: 'unnormalisable_phone' }

    const { data: template } = await db
      .from('whatsapp_templates').select('*')
      .eq('name', templateName).eq('location_id', locationId).maybeSingle()
    if (!template) return { sent: false, reason: 'template_not_found' }
    if (template.status !== 'APPROVED') return { sent: false, reason: `template_${template.status}` }

    const components = [{
      type: 'body',
      parameters: bodyParams.map((v) => ({ type: 'text', text: (v == null || v === '') ? ' ' : String(v) })),
    }]

    // INTEG-C3 — booking confirmations are TRANSACTIONAL: never blocked
    // by billing, log-only (loud at/below the −€10 grace floor).
    // Fire-and-forget; the helper never rejects.
    logTransactionalWalletState(db, locationId, 'wa_template_send')

    const result = await sendTemplateMessage(waPhone, template.name, template.language || 'en', components, { locationId })

    if (!contact.wa_phone) {
      try { await db.from('contacts').update({ wa_phone: waPhone }).eq('id', contact.id).is('wa_phone', null) }
      catch (e) { logWarn('booking-wa-confirm', 'wa_phone backfill failed', { err: e }) }
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
