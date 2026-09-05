// POST /api/contacts/[id]/whatsapp — contact-scoped WhatsApp send.
//
// CONTACT-COMPOSER.1 — backs the unified "Message this customer"
// composer on the contact profile. One call: get-or-create the
// contact's whatsapp_conversation, send, and log.
//
// Body is exactly one of:
//   { text }          — free text. Only delivers inside the open 24h
//                       customer-service window; 409 (window_expired)
//                       if the window has closed.
//   { template_name } — an approved WhatsApp UTILITY template, which
//                       delivers regardless of the window. A single
//                       body variable (if any) is filled with the
//                       contact's first name.
//
// Authorization: the 'whatsapp' permission + the contact's location
// (assertLocationAccess — same IDOR guard the SMS surface uses).
//
// Side effects on success: a whatsapp_messages row, the conversation's
// last-message fields refreshed, and a 'whatsapp_sent' activity on the
// contact timeline (mirrors the ad-hoc SMS surface).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission, hasMobilePermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { sendTextMessage, sendTemplateMessage, isWindowOpen, headerComponentFor } from '@/lib/whatsapp'
import {
  extractTemplateBody,
  isSendableUtilityTemplate,
  buildBodyComponents,
} from '@/lib/radar-outreach'
import { manualTakeoverPatch } from '@/lib/agent/core'
import { getOrCreateContactConversation } from '@/lib/whatsapp-conversations'

export const runtime = 'nodejs'

const SendSchema = z.object({
  text: z.string().min(1).max(4096).optional(),
  template_name: z.string().min(1).max(200).optional(),
}).refine((d) => Boolean(d.text) !== Boolean(d.template_name), {
  message: 'Provide exactly one of text or template_name',
})

function firstNameOf(contact) {
  if (contact?.first_name && String(contact.first_name).trim()) {
    return String(contact.first_name).trim()
  }
  return String(contact?.name || '').trim().split(/\s+/)[0] || 'there'
}

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  // Web sidebar `whatsapp` OR the `.mobile.whatsapp` toggle — the
  // composer ships on both the web contact profile and the iOS app.
  if (!hasPermission(user, 'whatsapp') && !hasMobilePermission(user, 'whatsapp')) {
    return NextResponse.json({ success: false, error: 'Forbidden — WhatsApp not enabled at this location for your role' }, { status: 403 })
  }

  const validation = await validateBody(request, SendSchema)
  if (!validation.ok) return validation.response
  const { text, template_name } = validation.data

  const { id: contactId } = params
  const db = createServerClient()

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, name, first_name, phone, wa_phone, location_id')
    .eq('id', contactId)
    .single()
  if (contactErr || !contact) {
    return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  }

  // IDOR guard — caller must be assigned to the contact's location.
  const guard = assertLocationAccessOr404(user, contact.location_id)
  if (guard) return guard

  // CANCEL-FORM.4 — get-or-create moved to lib/whatsapp-conversations so the
  // cancellation-form send opens the same thread this composer does.
  const opened = await getOrCreateContactConversation(db, contact)
  if (!opened.ok) {
    return NextResponse.json({ success: false, error: opened.error }, { status: opened.status })
  }
  const { conversation, waPhone } = opened

  // ── Send ────────────────────────────────────────────────────────
  let result
  let messageType
  let messageBody
  let sentTemplateName = null
  try {
    if (text) {
      // Free text only delivers inside the open 24h window.
      if (!isWindowOpen(conversation)) {
        return NextResponse.json({
          success: false,
          error: 'The 24-hour messaging window has closed. Send an approved template to reopen the conversation, or use SMS.',
          window_expired: true,
        }, { status: 409 })
      }
      result = await sendTextMessage(waPhone, text, { locationId: contact.location_id })
      messageType = 'text'
      messageBody = text
    } else {
      // Template — re-verify server-side that it's a sendable utility
      // template; never trust the client's pick.
      const { data: rows } = await db
        .from('whatsapp_templates')
        .select('name, language, category, status, components, header_media_url')
        .eq('location_id', contact.location_id)
        .eq('name', template_name)
        .order('created_at', { ascending: false })
        .limit(1)
      const template = rows?.[0]
      if (!template) {
        return NextResponse.json({ success: false, error: 'That template was not found for this location.' }, { status: 404 })
      }
      if (!isSendableUtilityTemplate(template)) {
        return NextResponse.json({ success: false, error: 'That template is not an approved utility template that can be sent.' }, { status: 400 })
      }
      const { varCount } = extractTemplateBody(template.components)
      const components = buildBodyComponents(varCount, firstNameOf(contact))
      // WA-TMPL-SEND.1 — attach the media-header param when the
      // template needs one (stored URL from the template upload).
      const headerComponent = headerComponentFor(template.components, template.header_media_url)
      if (headerComponent) components.unshift(headerComponent)
      result = await sendTemplateMessage(
        waPhone, template.name, template.language || 'en', components,
        { locationId: contact.location_id },
      )
      messageType = 'template'
      messageBody = `[Template: ${template.name}]`
      sentTemplateName = template.name
    }
  } catch (e) {
    return NextResponse.json({ success: false, error: e?.message || 'Failed to send WhatsApp message' }, { status: 502 })
  }

  // ── Log ─────────────────────────────────────────────────────────
  const nowIso = new Date().toISOString()
  await db.from('whatsapp_messages').insert({
    conversation_id: conversation.id,
    contact_id: contactId,
    location_id: contact.location_id,
    wa_message_id: result.messageId,
    direction: 'outbound',
    message_type: messageType,
    body: messageBody,
    template_name: sentTemplateName,
    status: 'sent',
    // sent_by is UUID REFERENCES profiles(id) (mig 007) — write the session
    // user's id, never their display name. A name string raises
    // `invalid input syntax for type uuid`, which supabase-js returns on the
    // result (not thrown); this insert isn't .error-checked, so the row would
    // be silently dropped. Matches the inbox + radar-outreach send paths.
    sent_by: user.id,
    sent_at: nowIso,
  })
  // Manual operator send = intentional human take-over → pause Mia in this
  // thread (auto re-arms after the cooldown / on resolve). Same as the inbox.
  await db.from('whatsapp_conversations').update({
    last_message_at: nowIso,
    last_message_direction: 'outbound',
    last_message_preview: messageBody?.substring(0, 100),
    ...manualTakeoverPatch(conversation.agent_handed_off_at),
  }).eq('id', conversation.id)
  // Timeline activity — mirrors the ad-hoc SMS surface so the
  // contact's timeline shows the send. Best-effort: the message is
  // already delivered, so a log failure must not fail the response.
  await db.from('activities').insert({
    contact_id: contactId,
    location_id: contact.location_id,
    type: 'whatsapp_sent',
    subject: 'WhatsApp sent',
    note: messageBody,
    created_by: user.id,
  })

  return NextResponse.json({
    success: true,
    data: { messageId: result.messageId, conversationId: conversation.id },
  })
}
