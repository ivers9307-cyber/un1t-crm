import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { sendTextMessage, sendTemplateMessage, sendMediaMessage, isWindowOpen, headerComponentFor } from '@/lib/whatsapp'
import { getCurrentUser, assertLocationAccessOr404, requireInboxPermission } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { url } from '@/lib/schemas'
import { manualTakeoverPatch } from '@/lib/agent/core'
import { logError } from '@/lib/log'
import { flowButtonIndex, flowButtonComponentFor } from '@/lib/whatsapp-template-buttons'
import { flowTokenFor } from '@/lib/whatsapp-flow/config'
import { templateSendBlock, SEND_BLOCK_TEXT, renderSentTemplateBody } from '@shared/wa-template-send'

const SendMessageSchema = z.object({
  type: z.enum(['text', 'template', 'image', 'video', 'document', 'audio']).optional(),
  text: z.string().max(4096).optional(),
  body: z.string().max(4096).optional(),
  template_name: z.string().max(200).optional(),
  template_language: z.string().max(20).optional(),
  template_components: z.array(z.unknown()).optional(),
  media_url: url.optional(),
  caption: z.string().max(1024).optional(),
})

const LOG = 'wa-conv-send'

// Staff-facing text (the web inbox shows it in an alert, the phone in an Alert).
// Plain words, no em-dashes.
const WINDOW_EXPIRED = 'The 24-hour messaging window has expired. You can only send approved template messages outside the window.'
const TEXT = Object.freeze({
  noTemplate: 'Pick a template to send.',
  templateReadFailed: 'Could not read that template, so nothing was sent. Try again.',
  templateMissing: "That template is not in this studio's approved list in that language, so nothing was sent. Reopen the template list and pick it again.",
  flowNeedsContact: 'Not sent. This template has a booking Flow button, which books against a contact: add the sender as a contact first.',
  notLogged: 'Sent to the customer, but it could not be saved to this thread. Do not send it again.',
  threadNotUpdated: 'Sent to the customer, but the conversation could not be updated, so it may not move to the top of the list and Mia may still reply in this thread.',
})
const blockedText = (block) => `This template can't be sent from the inbox. ${SEND_BLOCK_TEXT[block]}`
// A template judged as if it had no HEADER: what is left to refuse once a
// client has supplied its own header parameter.
const withoutHeader = (tpl) => ({
  ...tpl,
  components: (Array.isArray(tpl.components) ? tpl.components : [])
    .filter((c) => String(c?.type || '').toUpperCase() !== 'HEADER'),
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

  const messageType = body.type || 'text'
  let messageBody = body.text || body.body || ''
  let templateName = null
  let templateVariables = null
  let send // () => Promise<{ messageId }>: the ONE call that reaches Meta

  if (messageType === 'template') {
    // Template message — works outside the 24h window.
    if (!body.template_name) {
      return NextResponse.json({ success: false, error: TEXT.noTemplate }, { status: 400 })
    }
    const language = body.template_language || 'en'

    // WATPLSEND.1 — read the row BEFORE sending, and judge the read. It decides
    // the media header (WA-TMPL-SEND.1), the Flow button, what is refused, and
    // the logged text. Name + LANGUAGE, because Meta keys a template on both and
    // no unique index stops one name existing here in two languages.
    // APPROVED only: a PAUSED/REJECTED/DISABLED row must not reach Meta, and
    // both pickers list only APPROVED rows. Newest first + limit(1): the sync
    // (/api/whatsapp/templates) upserts on meta_template_id and never deletes
    // a row Meta dropped, so a template deleted and re-created at Meta leaves
    // two rows with one (studio, name, language); without the order, >1 row
    // made maybeSingle error and the template could never be sent again. By
    // created_at, not updated_at: the counter RPCs bump updated_at on the old
    // row too. 0 rows is a real answer (not approved at this studio).
    const { data: tplRow, error: tplError } = await db
      .from('whatsapp_templates')
      .select('name, language, components, header_media_url')
      .eq('location_id', conversation.location_id)
      .eq('name', body.template_name)
      .eq('language', language)
      .eq('status', 'APPROVED')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (tplError) {
      logError(LOG, 'template read failed; nothing sent', {
        conversationId: params.id, locationId: conversation.location_id, template: body.template_name, err: tplError.message,
      })
      return NextResponse.json({ success: false, error: TEXT.templateReadFailed }, { status: 500 })
    }
    if (!tplRow) {
      return NextResponse.json({ success: false, error: TEXT.templateMissing }, { status: 400 })
    }

    // Button parameters are server-only: the Flow token names the contact and
    // studio a booking lands on, so no client chooses it. Neither inbox sends
    // one (they send only the body), so this drops nothing real.
    const clientComponents = (body.template_components || [])
      .filter((c) => String(c?.type || '').toLowerCase() !== 'button')
    let components = clientComponents
    const clientHasHeader = components.some((c) => String(c?.type || '').toLowerCase() === 'header')

    // Refuse exactly what the pickers grey out (shared/wa-template-send.js),
    // before anything reaches Meta. A client that brings its own header is
    // excused the HEADER rules only: the rest of the template is still judged,
    // so a header block cannot mask a button block (templateSendBlock names
    // the header first).
    const block = templateSendBlock(clientHasHeader ? withoutHeader(tplRow) : tplRow)
    if (block) {
      return NextResponse.json({ success: false, error: blockedText(block), blocked: block }, { status: 400 })
    }

    // WA-TMPL-SEND.1 — a media-header template gets the header stored at upload.
    if (!clientHasHeader) {
      const headerComponent = headerComponentFor(tplRow.components, tplRow.header_media_url)
      if (headerComponent) components = [headerComponent, ...components]
    }

    // WATPLSEND.1 — a FLOW button needs its per-send token (Meta 131009 without
    // it). Same format and builder as broadcasts and sequences.
    if (flowButtonIndex(tplRow.components) >= 0) {
      const flowComponent = flowButtonComponentFor(tplRow.components, flowTokenFor(contact?.id, conversation.location_id))
      if (!flowComponent) {
        return NextResponse.json({ success: false, error: TEXT.flowNeedsContact }, { status: 400 })
      }
      components = [...components, flowComponent]
    }

    templateName = body.template_name
    // What the client supplied that the route honoured (never a dropped button).
    templateVariables = clientComponents
    // WATPLLOG.1 — the text the customer read, filled by variable NUMBER.
    messageBody = renderSentTemplateBody(tplRow, components) || `[Template: ${templateName}]`
    // Route from THIS location's WhatsApp number (whatsapp_numbers), not the
    // env default.
    send = () => sendTemplateMessage(phone, templateName, language, components, { locationId: conversation.location_id })
  } else if (['image', 'video', 'document', 'audio'].includes(messageType)) {
    // Media message — 24h window only
    if (!isWindowOpen(conversation)) {
      return NextResponse.json({ success: false, error: WINDOW_EXPIRED, window_expired: true }, { status: 400 })
    }
    messageBody = body.caption || `[${messageType}]`
    send = () => sendMediaMessage(phone, messageType, body.media_url, body.caption, { locationId: conversation.location_id })
  } else {
    // Text message — 24h window only
    if (!isWindowOpen(conversation)) {
      return NextResponse.json({ success: false, error: WINDOW_EXPIRED, window_expired: true }, { status: 400 })
    }
    send = () => sendTextMessage(phone, messageBody, { locationId: conversation.location_id })
  }

  let result
  try {
    result = await send()
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message }, { status: 400 })
  }

  // ── Meta has accepted the message: the customer has it. ─────────────────────
  // Nothing below may report the send as failed (CLAUDE.md: removing a silent
  // failure must never create a louder one). Each write is judged, logged
  // structurally, and surfaced as a WARNING on a successful response.
  const warnings = []
  const now = new Date().toISOString()

  let insertError = null
  try {
    const { error: err } = await db.from('whatsapp_messages').insert({
      conversation_id: params.id,
      contact_id: contact?.id || null,
      location_id: conversation.location_id,
      wa_message_id: result?.messageId,
      direction: 'outbound',
      message_type: messageType,
      body: messageBody,
      media_url: body.media_url || null,
      template_name: templateName,
      template_variables: templateVariables,
      status: 'sent',
      // sent_by is UUID REFERENCES profiles(id): take the operator from the
      // SESSION, never the request body (a client string would be rejected by
      // Postgres, and a mobile send posts none). Matches the composer send.
      sent_by: user.id,
      sent_at: now,
    })
    insertError = err
  } catch (err) {
    insertError = err
  }
  if (insertError) {
    logError(LOG, 'message insert failed after Meta accepted the send', {
      conversationId: params.id, locationId: conversation.location_id, waMessageId: result?.messageId, messageType, err: insertError.message,
    })
    warnings.push(TEXT.notLogged)
  }

  // Sending as a human is an intentional TAKE-OVER: stop Mia auto-replying in
  // this thread (core.js's agent_active gate). She re-arms after
  // handoff_cooldown_hours of quiet, or when the thread is resolved.
  let updateError = null
  try {
    const { error: err } = await db.from('whatsapp_conversations').update({
      last_message_at: now,
      last_message_direction: 'outbound',
      last_message_preview: messageBody?.substring(0, 100),
      ...manualTakeoverPatch(conversation.agent_handed_off_at),
    }).eq('id', params.id)
    updateError = err
  } catch (err) {
    updateError = err
  }
  if (updateError) {
    logError(LOG, 'conversation update failed after Meta accepted the send (Mia not paused)', {
      conversationId: params.id, locationId: conversation.location_id, waMessageId: result?.messageId, err: updateError.message,
    })
    warnings.push(TEXT.threadNotUpdated)
  }

  return NextResponse.json({
    success: true,
    messageId: result?.messageId,
    ...(warnings.length ? { warnings } : {}),
  })
}
