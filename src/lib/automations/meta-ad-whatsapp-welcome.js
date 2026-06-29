// First-touch WhatsApp welcome for paid-campaign leads (e.g. the Meta
// "3 free classes" ad → /free-class page). The instant a campaign lead
// submits the form, send them an APPROVED template that asks how they'd
// like to start (consultation vs first class) via quick-reply buttons.
// When they tap one, the inbound reply opens the 24h window and the Mia
// agent takes over and books them in.
//
// Why a bespoke send rather than the sequence engine: sequence WhatsApp
// steps hard-require `contacts.wa_phone`, which a brand-new website lead
// never has (it's only set on a real inbound WA interaction). A cold
// lead only has `contacts.phone`. So we send directly to the normalised
// phone via sendTemplateMessage(), then — only AFTER Meta accepts the
// send — persist wa_phone so the outbound logs to a conversation and the
// reply routes back to this contact (+ Mia). We're INITIATING WhatsApp
// contact here, so marking the number reachable is accurate (this is the
// one legitimate way to set wa_phone from phone — see the broadcast-
// reachability note in MEMORY).

import { toE164Ireland } from '@/lib/twilio'
import {
  sendTemplateMessage,
  buildTemplateComponents,
  renderTemplateBody,
  getOrCreateConversation,
} from '@/lib/whatsapp'
import { logWarn } from '@/lib/log'

// The template's only body variable {{1}} is the lead's first name.
const VARIABLE_MAPPING = { '1': 'first_name' }

/**
 * Best-effort. Sends the campaign's WhatsApp welcome template to a fresh
 * lead and logs it to the inbox. Never throws — callers run it as a
 * fire-and-forget side effect that must not fail the lead capture.
 *
 * @returns {Promise<{sent: boolean, reason?: string, messageId?: string}>}
 */
export async function maybeSendCampaignWhatsappWelcome({ db, locationId, contact, templateName }) {
  try {
    if (!templateName) return { sent: false, reason: 'no_template_configured' }
    if (!contact?.phone) return { sent: false, reason: 'no_phone' }

    const waPhone = toE164Ireland(contact.phone)
    // toE164Ireland returns the cleaned digits unchanged when it can't
    // confidently format (e.g. a foreign/garbage number) — require a
    // plausible E.164 before we hand it to Meta.
    if (!waPhone || !/^\+\d{10,15}$/.test(waPhone)) return { sent: false, reason: 'unnormalisable_phone' }

    // Resolve the template; must be this location's and APPROVED to send.
    const { data: template } = await db
      .from('whatsapp_templates')
      .select('*')
      .eq('name', templateName)
      .eq('location_id', locationId)
      .maybeSingle()
    if (!template) return { sent: false, reason: 'template_not_found' }
    if (template.status !== 'APPROVED') return { sent: false, reason: `template_${template.status}` }

    // Build header (media auto-attached from the template row) + body var.
    const components = buildTemplateComponents(
      template,
      contact,
      VARIABLE_MAPPING,
      template.header_media_url || null,
    )

    const result = await sendTemplateMessage(
      waPhone,
      template.name,
      template.language || 'en',
      components,
      { locationId },
    )

    // Meta accepted it. NOW persist wa_phone (only if unset) so the inbox
    // thread + the reply→Mia routing attribute to this contact, and log
    // the outbound so staff/Mia see what was sent.
    if (!contact.wa_phone) {
      try {
        await db.from('contacts').update({ wa_phone: waPhone }).eq('id', contact.id).is('wa_phone', null)
      } catch (e) { logWarn('meta-ad-wa-welcome', 'wa_phone backfill failed', { err: e }) }
      contact = { ...contact, wa_phone: waPhone }
    }

    try {
      const conversationId = await getOrCreateConversation(db, contact, locationId)
      if (conversationId && result?.messageId) {
        await db.from('whatsapp_messages').insert({
          conversation_id: conversationId,
          contact_id: contact.id,
          location_id: locationId,
          wa_message_id: result.messageId,
          direction: 'outbound',
          message_type: 'template',
          template_name: template.name,
          template_variables: VARIABLE_MAPPING,
          body: renderTemplateBody(template, contact, VARIABLE_MAPPING),
          status: 'sent',
          sent_at: new Date().toISOString(),
        })
      }
    } catch (e) { logWarn('meta-ad-wa-welcome', 'inbox log failed', { err: e }) }

    return { sent: true, messageId: result?.messageId || null }
  } catch (e) {
    // Includes Meta rejections (e.g. the number isn't on WhatsApp) — swallow.
    logWarn('meta-ad-wa-welcome', 'send failed', { err: e })
    return { sent: false, reason: 'send_failed' }
  }
}
