import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { sendTextMessage, sendTemplateMessage, sendMediaMessage, isWindowOpen } from '@/lib/whatsapp'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { url } from '@/lib/schemas'

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
  const guard = assertLocationAccess(user, conversation.location_id)
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
      // Template message — works outside 24h window
      result = await sendTemplateMessage(
        phone,
        body.template_name,
        body.template_language || 'en',
        body.template_components || []
      )
      templateName = body.template_name
      messageBody = `[Template: ${body.template_name}]`
    } else if (['image', 'video', 'document', 'audio'].includes(messageType)) {
      // Media message — 24h window only
      if (!isWindowOpen(conversation)) {
        return NextResponse.json({
          success: false,
          error: 'The 24-hour messaging window has expired. You can only send approved template messages outside the window.',
          window_expired: true,
        }, { status: 400 })
      }
      result = await sendMediaMessage(phone, messageType, body.media_url, body.caption)
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
      result = await sendTextMessage(phone, messageBody)
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

    // Update conversation
    await db.from('whatsapp_conversations').update({
      last_message_at: new Date().toISOString(),
      last_message_direction: 'outbound',
      last_message_preview: messageBody?.substring(0, 100),
    }).eq('id', params.id)

    return NextResponse.json({ success: true, messageId: result.messageId })
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message }, { status: 400 })
  }
}
