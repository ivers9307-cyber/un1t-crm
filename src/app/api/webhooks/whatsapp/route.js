import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { refreshWindow } from '@/lib/whatsapp'
import { verifyMetaSignature, safeEqual } from '@/lib/webhook-auth'
import { sendPush, sendPushToRolesAtLocation } from '@/lib/push'
import { MANAGER_ROLES } from '@/lib/schemas'

// Force Node.js runtime — we use node:crypto for HMAC verification.
export const runtime = 'nodejs'

// GET — Meta webhook verification (required for setup)
export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const mode = searchParams.get('hub.mode')
  const token = searchParams.get('hub.verify_token')
  const challenge = searchParams.get('hub.challenge')

  const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN
  if (!verifyToken) {
    console.error('WHATSAPP_WEBHOOK_VERIFY_TOKEN is not set — refusing verification')
    return NextResponse.json({ success: false, error: 'Server misconfigured' }, { status: 500 })
  }

  if (mode === 'subscribe' && safeEqual(token || '', verifyToken)) {
    return new Response(challenge, { status: 200 })
  }

  return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
}

// POST — Incoming messages and status updates from Meta
export async function POST(request) {
  // Read the raw body FIRST — HMAC must be computed over the exact bytes
  // Meta sent. Reading it via request.json() would consume the body and
  // re-serialising would not byte-match.
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')
  const appSecret = process.env.WHATSAPP_APP_SECRET

  // If the App Secret is configured, enforce signature verification.
  // If it's not yet configured, log loudly so the misconfiguration is visible
  // but accept the request (rollout-safe — set the secret to activate enforcement).
  if (appSecret) {
    const result = verifyMetaSignature(rawBody, signature, appSecret)
    if (!result.ok) {
      console.warn(`WhatsApp webhook rejected: ${result.reason}`)
      return NextResponse.json({ success: false, error: 'Invalid signature' }, { status: 403 })
    }
  } else {
    console.warn(
      '[security] WHATSAPP_APP_SECRET is not set — accepting WhatsApp webhook ' +
      'without signature verification. Set the env var to enable enforcement.'
    )
  }

  let body
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 })
  }

  const db = createServerClient()

  try {
    const entries = body.entry || []
    if (process.env.NODE_ENV !== 'production') {
      console.log('WhatsApp webhook received:', rawBody.substring(0, 500))
    }

    for (const entry of entries) {
      const changes = entry.changes || []

      for (const change of changes) {
        if (change.field !== 'messages') continue

        const value = change.value
        const phoneNumberId = value.metadata?.phone_number_id

        // Handle incoming messages
        if (value.messages) {
          for (const message of value.messages) {
            await handleIncomingMessage(db, message, value.contacts, phoneNumberId)
          }
        }

        // Handle status updates (sent, delivered, read, failed)
        if (value.statuses) {
          for (const status of value.statuses) {
            await handleStatusUpdate(db, status)
          }
        }
      }
    }
  } catch (err) {
    console.error('WhatsApp webhook error:', err.message, err.stack)
  }

  // Always return 200 to Meta (they retry on non-200)
  return NextResponse.json({ success: true })
}

async function handleIncomingMessage(db, message, contacts, _phoneNumberId) {
  const senderPhone = message.from  // E.164 format
  const messageId = message.id
  const timestamp = message.timestamp ? new Date(parseInt(message.timestamp) * 1000) : new Date()

  // Get sender name from Meta's contacts array
  const metaContact = contacts?.find(c => c.wa_id === senderPhone)
  const senderName = metaContact?.profile?.name || null

  // Get default location
  let defaultLocationId = null
  const { data: locations } = await db.from('locations').select('id').limit(1)
  if (locations?.length) defaultLocationId = locations[0].id

  // Try to find existing contact by phone number
  // Meta sends phone without '+' (e.g. 353873147675), but contacts may store it
  // with '+' (e.g. +353873147675). Check both formats.
  const phoneWithPlus = senderPhone.startsWith('+') ? senderPhone : `+${senderPhone}`
  const phoneWithout = senderPhone.startsWith('+') ? senderPhone.slice(1) : senderPhone

  let contact = null
  const { data: existingContacts } = await db.from('contacts')
    .select('id, location_id')
    .or(`wa_phone.eq.${phoneWithout},wa_phone.eq.${phoneWithPlus},phone.eq.${phoneWithout},phone.eq.${phoneWithPlus}`)
    .limit(1)

  if (existingContacts?.length) {
    contact = existingContacts[0]

    // Ensure wa_phone is set on the contact (store without + to match Meta's format)
    await db.from('contacts')
      .update({ wa_phone: phoneWithout })
      .eq('id', contact.id)
      .is('wa_phone', null)
  }

  // Determine location — use contact's location if known, otherwise default
  const locationId = contact?.location_id || defaultLocationId

  // Get or create conversation (keyed by phone number, NOT by contact)
  const { data: existingConv } = await db.from('whatsapp_conversations')
    .select('id, contact_id')
    .eq('wa_phone', senderPhone)
    .eq('location_id', locationId)
    .limit(1)
    .single()

  let conversationId
  if (existingConv) {
    conversationId = existingConv.id
    // If contact was found but conversation wasn't linked yet, link it now
    if (contact && !existingConv.contact_id) {
      await db.from('whatsapp_conversations')
        .update({ contact_id: contact.id })
        .eq('id', conversationId)
    }
  } else {
    const { data: newConv } = await db.from('whatsapp_conversations').insert({
      location_id: locationId,
      contact_id: contact?.id || null,  // null if unknown sender
      wa_phone: senderPhone,
      wa_profile_name: senderName,
      status: 'active',
    }).select('id').single()
    conversationId = newConv?.id
  }

  if (!conversationId) {
    console.error('Could not create conversation for:', senderPhone)
    return
  }

  // Update profile name if we have one (it can change)
  if (senderName) {
    await db.from('whatsapp_conversations')
      .update({ wa_profile_name: senderName })
      .eq('id', conversationId)
  }

  // Refresh 24h window (inbound message opens the window)
  await refreshWindow(db, conversationId)

  // Extract message content
  let body = ''
  let messageType = message.type || 'text'
  let mediaUrl = null
  let mediaMime = null

  switch (messageType) {
    case 'text':
      body = message.text?.body || ''
      break
    case 'image':
      body = message.image?.caption || ''
      mediaUrl = message.image?.id
      mediaMime = message.image?.mime_type
      break
    case 'video':
      body = message.video?.caption || ''
      mediaUrl = message.video?.id
      mediaMime = message.video?.mime_type
      break
    case 'document':
      body = message.document?.caption || message.document?.filename || ''
      mediaUrl = message.document?.id
      mediaMime = message.document?.mime_type
      break
    case 'audio':
      mediaUrl = message.audio?.id
      mediaMime = message.audio?.mime_type
      break
    case 'location':
      body = `Location: ${message.location?.latitude}, ${message.location?.longitude}`
      break
    case 'contacts':
      body = `Shared contact: ${message.contacts?.[0]?.name?.formatted_name || 'Unknown'}`
      break
    case 'interactive':
      body = message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || ''
      break
    case 'reaction':
      body = `Reacted: ${message.reaction?.emoji || ''}`
      break
    default:
      body = `[${messageType} message]`
  }

  // Save message (contact_id is null for unknown senders)
  await db.from('whatsapp_messages').insert({
    conversation_id: conversationId,
    contact_id: contact?.id || null,
    location_id: locationId,
    wa_message_id: messageId,
    direction: 'inbound',
    message_type: messageType,
    body,
    media_url: mediaUrl,
    media_mime_type: mediaMime,
    status: 'delivered',
    sent_at: timestamp.toISOString(),
  })

  // Get current unread count to increment
  const { data: currentConv } = await db.from('whatsapp_conversations')
    .select('unread_count')
    .eq('id', conversationId)
    .single()

  // Update conversation
  await db.from('whatsapp_conversations').update({
    last_message_at: timestamp.toISOString(),
    last_message_direction: 'inbound',
    last_message_preview: body?.substring(0, 100) || `[${messageType}]`,
    unread_count: (currentConv?.unread_count || 0) + 1,
  }).eq('id', conversationId)

  // Push notification fan-out for inbound WhatsApp.
  //   - If the conversation is assigned to a specific user, push to them.
  //   - Otherwise push to owners + managers + head coaches at the location.
  // Per-user opt-in is gated by permissions.mobile.notify_whatsapp inside
  // sendPush(). Best-effort — never throw out of the webhook handler.
  try {
    const { data: conv } = await db.from('whatsapp_conversations')
      .select('assigned_to, location_id, contacts(name, first_name, wa_profile_name)')
      .eq('id', conversationId)
      .single()
    const senderLabel = conv?.contacts?.name
      || conv?.contacts?.first_name
      || conv?.contacts?.wa_profile_name
      || senderName
      || 'a contact'
    const preview = body?.substring(0, 140) || `[${messageType}]`
    const payload = {
      title: `WhatsApp · ${senderLabel}`,
      body: preview,
      category: 'whatsapp',
      data: {
        type: 'whatsapp_inbound',
        conversation_id: conversationId,
      },
    }
    if (conv?.assigned_to) {
      await sendPush([conv.assigned_to], payload)
    } else if (conv?.location_id) {
      await sendPushToRolesAtLocation(
        conv.location_id,
        MANAGER_ROLES,
        payload
      )
    }
  } catch (err) {
    console.error('[whatsapp webhook] push failed', err)
  }
}

async function handleStatusUpdate(db, status) {
  const messageId = status.id
  const statusValue = status.status  // sent, delivered, read, failed
  const timestamp = status.timestamp ? new Date(parseInt(status.timestamp) * 1000) : new Date()

  const updates = { status: statusValue }

  switch (statusValue) {
    case 'sent':
      updates.sent_at = timestamp.toISOString()
      break
    case 'delivered':
      updates.delivered_at = timestamp.toISOString()
      break
    case 'read':
      updates.read_at = timestamp.toISOString()
      break
    case 'failed':
      updates.error_code = status.errors?.[0]?.code?.toString()
      updates.error_message = status.errors?.[0]?.title || 'Delivery failed'
      break
  }

  // Update message record
  await db.from('whatsapp_messages')
    .update(updates)
    .eq('wa_message_id', messageId)

  // Update broadcast recipient if this was a broadcast message
  const { data: msg } = await db.from('whatsapp_messages')
    .select('broadcast_id, contact_id')
    .eq('wa_message_id', messageId)
    .single()

  if (msg?.broadcast_id) {
    const recipUpdates = { status: statusValue }
    if (statusValue === 'delivered') recipUpdates.delivered_at = timestamp.toISOString()
    if (statusValue === 'read') recipUpdates.read_at = timestamp.toISOString()
    if (statusValue === 'failed') {
      recipUpdates.failed_at = timestamp.toISOString()
      recipUpdates.error_message = status.errors?.[0]?.title
    }

    await db.from('whatsapp_broadcast_recipients')
      .update(recipUpdates)
      .eq('broadcast_id', msg.broadcast_id)
      .eq('contact_id', msg.contact_id)

    // Update broadcast metrics
    if (['delivered', 'read', 'failed'].includes(statusValue)) {
      const metricField = statusValue === 'delivered' ? 'total_delivered'
        : statusValue === 'read' ? 'total_read'
        : 'total_failed'

      const { data: broadcast } = await db.from('whatsapp_broadcasts')
        .select(metricField)
        .eq('id', msg.broadcast_id)
        .single()

      if (broadcast) {
        await db.from('whatsapp_broadcasts')
          .update({ [metricField]: (broadcast[metricField] || 0) + 1 })
          .eq('id', msg.broadcast_id)
      }
    }
  }
}
