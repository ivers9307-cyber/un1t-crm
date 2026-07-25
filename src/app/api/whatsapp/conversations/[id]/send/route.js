import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { sendTextMessage, sendTemplateMessage, sendMediaMessage, isWindowOpen, substituteTemplateBody, headerComponentFor } from '@/lib/whatsapp'
import { getCurrentUser, assertLocationAccessOr404, requireInboxPermission } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { url } from '@/lib/schemas'
import { manualTakeoverPatch } from '@/lib/agent/core'

const SendMessageSchema = z.object({
  type: z.enum(['text', 'template', 'image', 'video', 'document', 'audio']).optional(),
  text: z.string().max(4096).optional(),
  body: z.string().max(4096).optional(),
  template_name: z.string().max(200).optional(),
  template_language: z.string().max(20).optional(),
  template_components: z.array(z.unknown()).optional(),
  media_url: url.optional(),
  caption: z.string().max(1024).optional(),
  sent_by: z.string().max(200).nullable().optional(),
})

// POST /api/whatsapp/conversations/[id]/send — send a message in a conversation
export async function POST(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  // Channel permission — service-role client, so this IS the gate (INBOX-PERM.1).
  const perm = requireInboxPermission(user, 'wa')
  if (perm) return perm

  const validation = await validateBody(request, SendMessageSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const db = createServerClient()

  // Get conversation
  const { data: conversation, error } = await db.from('whatsapp_conversations')
    .select('*, contacts!contact_id(id, name, wa_phone, location_id)')
    .eq('id', params.id)
    .single()

  if (error || !conversation) {
    return NextResponse.json({ success: false, error: 'Conversation not found' }, { status: 404 })
  }

  // Caller must belong to the conversation's location.
  const guard = assertLocationAccessOr404(user, conversation.location_id)
  if (guard) return guard

  const contact = conversation.contacts
  const phone = contact?.wa_phone || conversation.wa_phone

  if (!phone) {
    return NextResponse.json({ success: false, error: 'No WhatsApp number for this contact' }, { status: 400 })
  }

  try {
    let result
    let messageType = body.type || 'text'
    let messageBody = body.text || body.body || ''
    let templateName = null

    if (messageType === 'template') {
      // Template message — works outside 24h window.
      //
      // WA-TMPL-SEND.1 — fetch the template row BEFORE sending so a
      // media-header template gets its required header parameter
      // attached server-side. The inbox picker only collects body
      // variables; without this a VIDEO/IMAGE/DOCUMENT-header template
      // went to Meta header-less and failed every time with the
      // generic "An unexpected error has occurred" (bit live on
      // 2026-06-12 — same class as the 2026-06-11 broadcast bug that
      // buildTemplateComponents already guards). The header_media_url
      // stored at template upload is the fallback; a client-supplied
      // header component still wins.
      const { data: tplRow } = await db
        .from('whatsapp_templates')
        .select('components, header_media_url')
        .eq('name', body.template_name)
        .eq('location_id', conversation.location_id)
        .maybeSingle()

      let components = body.template_components || []
      const clientHasHeader = components.some((c) => String(c?.type || '').toLowerCase() === 'header')
      if (!clientHasHeader && tplRow) {
        const headerComponent = headerComponentFor(tplRow.components, tplRow.header_media_url)
        if (headerComponent) components = [headerComponent, ...components]
      }

      result = await sendTemplateMessage(
        phone,
        body.template_name,
        body.template_language || 'en',
        components,
        // Route from THIS location's WhatsApp number (whatsapp_numbers),
        // not the env-default — otherwise a manual reply goes out from the
        // wrong/agent number (or fails silently on a dead env token).
        { locationId: conversation.location_id }
      )
      templateName = body.template_name
      // Render the actual text the contact received so the thread shows
      // real content instead of a "[template]" placeholder: substitute
      // the client's param values into the template's BODY text. Falls
      // back to the placeholder if the row or body text is absent.
      messageBody = `[Template: ${body.template_name}]`
      try {
        const bodyText = (tplRow?.components || []).find((c) => c.type === 'BODY')?.text
        const values = ((body.template_components || []).find((c) => c.type === 'body')?.parameters || [])
          .map((p) => p?.text ?? '')
        const rendered = substituteTemplateBody(bodyText, values)
        if (rendered) messageBody = rendered
      } catch { /* keep placeholder */ }
    } else if (['image', 'video', 'document', 'audio'].includes(messageType)) {
      // Media message — 24h window only
      if (!isWindowOpen(conversation)) {
        return NextResponse.json({
          success: false,
          error: 'The 24-hour messaging window has expired. You can only send approved template messages outside the window.',
          window_expired: true,
        }, { status: 400 })
      }
      result = await sendMediaMessage(phone, messageType, body.media_url, body.caption, { locationId: conversation.location_id })
      messageBody = body.caption || `[${messageType}]`
    } else {
      // Text message — 24h window only
      if (!isWindowOpen(conversation)) {
        return NextResponse.json({
          success: false,
          error: 'The 24-hour messaging window has expired. You can only send approved template messages outside the window.',
          window_expired: true,
        }, { status: 400 })
      }
      result = await sendTextMessage(phone, messageBody, { locationId: conversation.location_id })
    }

    // Save message to DB
    await db.from('whatsapp_messages').insert({
      conversation_id: params.id,
      contact_id: contact?.id || null,
      location_id: conversation.location_id,
      wa_message_id: result.messageId,
      direction: 'outbound',
      message_type: messageType,
      body: messageBody,
      media_url: body.media_url || null,
      template_name: templateName,
      template_variables: body.template_components || null,
      status: 'sent',
      sent_by: body.sent_by || null,
      sent_at: new Date().toISOString(),
    })

    // Update conversation. Sending as a human is an intentional TAKE-OVER —
    // stop Mia auto-replying in this thread (mirrors the Instagram send route;
    // core.js's agent_active gate). Staff stay in control; the agent re-arms
    // after handoff_cooldown_hours of quiet, or instantly when the thread is
    // resolved.
    await db.from('whatsapp_conversations').update({
      last_message_at: new Date().toISOString(),
      last_message_direction: 'outbound',
      last_message_preview: messageBody?.substring(0, 100),
      ...manualTakeoverPatch(conversation.agent_handed_off_at),
    }).eq('id', params.id)

    return NextResponse.json({ success: true, messageId: result.messageId })
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message }, { status: 400 })
  }
}
