// Best-effort WhatsApp booking confirmation for campaign booking pages
// (/start). Sent as a UTILITY template (no 24h window after a web booking),
// straight to the lead's normalised phone, then wa_phone is backfilled so
// the message logs to a conversation and any reply routes to Mia. Mirrors
// the send pattern in meta-ad-whatsapp-welcome.js. Never throws.

import { toE164Ireland } from '@/lib/twilio'
import { sendTemplateMessage, getOrCreateConversation } from '@/lib/whatsapp'
import { logWarn } from '@/lib/log'

export async function maybeSendBookingWhatsappConfirm({ db, locationId, contact, templateName, bodyParams = [] }) {
  try {
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
