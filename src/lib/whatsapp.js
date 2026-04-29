import { createServerClient } from './supabase'

const META_API_VERSION = 'v21.0'
const META_API_URL = `https://graph.facebook.com/${META_API_VERSION}`

function getConfig() {
  const token = process.env.WHATSAPP_ACCESS_TOKEN
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID
  const businessAccountId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID

  if (!token || !phoneNumberId) {
    throw new Error(
      'WhatsApp not configured. Set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID in environment variables. ' +
      `WHATSAPP_ACCESS_TOKEN=${token ? 'SET' : 'MISSING'}, ` +
      `WHATSAPP_PHONE_NUMBER_ID=${phoneNumberId ? 'SET' : 'MISSING'}`
    )
  }

  return { token, phoneNumberId, businessAccountId }
}

function headers() {
  const { token } = getConfig()
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

// ============================================================
// SEND MESSAGES
// ============================================================

/**
 * Send a text message (only works within 24h window)
 */
export async function sendTextMessage(to, text) {
  const { phoneNumberId } = getConfig()

  const response = await fetch(`${META_API_URL}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: text },
    }),
  })

  const result = await response.json()
  if (result.error) {
    console.error('WhatsApp send error:', result.error)
    throw new Error(result.error.message || 'Failed to send WhatsApp message')
  }

  return {
    messageId: result.messages?.[0]?.id,
    status: result.messages?.[0]?.message_status || 'sent',
  }
}

/**
 * Send a template message (works anytime — no 24h window needed)
 */
export async function sendTemplateMessage(to, templateName, language = 'en', components = []) {
  const { phoneNumberId } = getConfig()

  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: language },
    },
  }

  // Add components if provided (header params, body params, buttons)
  if (components.length > 0) {
    body.template.components = components
  }

  const response = await fetch(`${META_API_URL}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  })

  const result = await response.json()
  if (result.error) {
    console.error('WhatsApp template send error:', result.error)
    throw new Error(result.error.message || 'Failed to send template message')
  }

  return {
    messageId: result.messages?.[0]?.id,
    status: result.messages?.[0]?.message_status || 'sent',
  }
}

/**
 * Send a media message (image, video, document) — 24h window only
 */
export async function sendMediaMessage(to, type, mediaUrl, caption) {
  const { phoneNumberId } = getConfig()

  const mediaTypes = {
    image: { image: { link: mediaUrl, caption } },
    video: { video: { link: mediaUrl, caption } },
    document: { document: { link: mediaUrl, caption, filename: caption || 'document' } },
    audio: { audio: { link: mediaUrl } },
  }

  const response = await fetch(`${META_API_URL}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type,
      ...mediaTypes[type],
    }),
  })

  const result = await response.json()
  if (result.error) throw new Error(result.error.message)

  return {
    messageId: result.messages?.[0]?.id,
    status: result.messages?.[0]?.message_status || 'sent',
  }
}

/**
 * Mark a message as read (sends blue ticks)
 */
export async function markAsRead(messageId) {
  const { phoneNumberId } = getConfig()

  await fetch(`${META_API_URL}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    }),
  })
}

// ============================================================
// TEMPLATE MANAGEMENT
// ============================================================

/**
 * Create a message template (submits to Meta for approval)
 */
export async function createTemplate({ name, category, language, components }) {
  const { businessAccountId } = getConfig()

  const response = await fetch(`${META_API_URL}/${businessAccountId}/message_templates`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      name,
      category: category || 'MARKETING',
      language: language || 'en',
      components: components || [],
    }),
  })

  const result = await response.json()
  if (result.error) {
    console.error('Template creation error:', result.error)
    throw new Error(result.error.message || 'Failed to create template')
  }

  return {
    id: result.id,
    status: result.status,
    category: result.category,
  }
}

/**
 * Get all templates from Meta
 */
export async function getTemplates(limit = 100) {
  const { businessAccountId } = getConfig()

  const response = await fetch(
    `${META_API_URL}/${businessAccountId}/message_templates?limit=${limit}`,
    { headers: headers() }
  )

  const result = await response.json()
  if (result.error) throw new Error(result.error.message)

  return result.data || []
}

/**
 * Get a single template by name
 */
export async function getTemplate(templateName) {
  const { businessAccountId } = getConfig()

  const response = await fetch(
    `${META_API_URL}/${businessAccountId}/message_templates?name=${templateName}`,
    { headers: headers() }
  )

  const result = await response.json()
  if (result.error) throw new Error(result.error.message)

  return result.data?.[0] || null
}

/**
 * Delete a template
 */
export async function deleteTemplate(templateName) {
  const { businessAccountId } = getConfig()

  const response = await fetch(
    `${META_API_URL}/${businessAccountId}/message_templates?name=${templateName}`,
    { method: 'DELETE', headers: headers() }
  )

  const result = await response.json()
  if (result.error) throw new Error(result.error.message)

  return { success: true }
}

// ============================================================
// AUDIENCE & BROADCAST
// ============================================================

/**
 * Build audience query for WhatsApp broadcasts
 * Same pattern as email but checks whatsapp_marketing consent and wa_phone
 */
export function buildWhatsAppAudience(db, filter, locationId) {
  let query = db
    .from('contacts')
    .select('*, contact_preferences!inner(*)')
    .eq('location_id', locationId)
    .eq('contact_preferences.whatsapp_marketing', true)
    .not('wa_phone', 'is', null)
    .neq('wa_status', 'blocked')
    .neq('wa_status', 'opted_out')

  if (!filter?.filters?.length) return query

  for (const f of filter.filters) {
    switch (f.op) {
      case 'eq':
        query = query.eq(f.field, f.value)
        break
      case 'neq':
        query = query.neq(f.field, f.value)
        break
      case 'gt':
        query = query.gt(f.field, f.value)
        break
      case 'lt':
        query = query.lt(f.field, f.value)
        break
      case 'gte':
        query = query.gte(f.field, f.value)
        break
      case 'lte':
        query = query.lte(f.field, f.value)
        break
      case 'contains':
        query = query.ilike(f.field, `%${f.value}%`)
        break
      case 'not_contains':
        query = query.not(f.field, 'ilike', `%${f.value}%`)
        break
      case 'is_null':
        query = query.is(f.field, null)
        break
      case 'not_null':
        query = query.not(f.field, 'is', null)
        break
      case 'days_since_gt': {
        const cutoff = new Date()
        cutoff.setDate(cutoff.getDate() - parseInt(f.value))
        query = query.lt(f.field, cutoff.toISOString())
        break
      }
      case 'days_since_lt': {
        const cutoff = new Date()
        cutoff.setDate(cutoff.getDate() - parseInt(f.value))
        query = query.gte(f.field, cutoff.toISOString())
        break
      }
    }
  }

  return query
}

/**
 * Send a broadcast — template message to filtered audience
 */
export async function sendBroadcast(broadcastId) {
  const db = createServerClient()

  // Get broadcast with template
  const { data: broadcast, error: bErr } = await db.from('whatsapp_broadcasts')
    .select('*, whatsapp_templates(*)')
    .eq('id', broadcastId)
    .single()

  if (bErr || !broadcast) throw new Error('Broadcast not found')
  if (!broadcast.whatsapp_templates) throw new Error('No template selected')
  if (broadcast.whatsapp_templates.status !== 'APPROVED') throw new Error('Template not approved by Meta')

  // Update status to sending
  await db.from('whatsapp_broadcasts').update({ status: 'sending' }).eq('id', broadcastId)

  // Get audience
  const audienceQuery = buildWhatsAppAudience(db, broadcast.audience_filter, broadcast.location_id)
  const { data: contacts, error: cErr } = await audienceQuery

  if (cErr) throw new Error(`Audience query failed: ${cErr.message}`)
  if (!contacts?.length) {
    await db.from('whatsapp_broadcasts').update({
      status: 'sent',
      sent_at: new Date().toISOString(),
      total_recipients: 0,
    }).eq('id', broadcastId)
    return { sent: 0 }
  }

  const template = broadcast.whatsapp_templates
  const variableMapping = broadcast.variable_mapping || {}
  let sentCount = 0
  let failedCount = 0

  for (const contact of contacts) {
    try {
      // Build template components with variable substitution
      const components = buildTemplateComponents(template, contact, variableMapping, broadcast.header_media_url)

      const result = await sendTemplateMessage(
        contact.wa_phone,
        template.name,
        template.language,
        components
      )

      // Create recipient record
      await db.from('whatsapp_broadcast_recipients').insert({
        broadcast_id: broadcastId,
        contact_id: contact.id,
        wa_message_id: result.messageId,
        status: 'sent',
        sent_at: new Date().toISOString(),
      })

      // Log to messages table
      await db.from('whatsapp_messages').insert({
        conversation_id: await getOrCreateConversation(db, contact, broadcast.location_id),
        contact_id: contact.id,
        location_id: broadcast.location_id,
        wa_message_id: result.messageId,
        direction: 'outbound',
        message_type: 'template',
        template_name: template.name,
        template_variables: variableMapping,
        status: 'sent',
        broadcast_id: broadcastId,
        sent_at: new Date().toISOString(),
      })

      sentCount++
    } catch (err) {
      console.error(`Failed to send to ${contact.wa_phone}:`, err.message)

      await db.from('whatsapp_broadcast_recipients').insert({
        broadcast_id: broadcastId,
        contact_id: contact.id,
        status: 'failed',
        error_message: err.message,
        failed_at: new Date().toISOString(),
      })

      failedCount++
    }

    // Rate limiting — Meta allows ~80 messages/second for verified businesses
    // Be conservative with a small delay
    if (sentCount % 50 === 0) {
      await new Promise(r => setTimeout(r, 1000))
    }
  }

  // Update broadcast metrics
  await db.from('whatsapp_broadcasts').update({
    status: 'sent',
    sent_at: new Date().toISOString(),
    total_recipients: contacts.length,
    total_sent: sentCount,
    total_failed: failedCount,
  }).eq('id', broadcastId)

  // Update template send count
  await db.from('whatsapp_templates').update({
    total_sent: template.total_sent + sentCount,
  }).eq('id', template.id)

  return { sent: sentCount, failed: failedCount, total: contacts.length }
}

/**
 * Build template components with contact-specific variable substitution
 */
function buildTemplateComponents(template, contact, variableMapping, headerMediaUrl) {
  const components = []
  const templateComponents = template.components || []

  // Check if template has a header with media
  const headerComp = templateComponents.find(c => c.type === 'HEADER')
  if (headerComp && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerComp.format) && headerMediaUrl) {
    components.push({
      type: 'header',
      parameters: [{
        type: headerComp.format.toLowerCase(),
        [headerComp.format.toLowerCase()]: { link: headerMediaUrl },
      }],
    })
  }

  // Check if template has body variables
  const bodyComp = templateComponents.find(c => c.type === 'BODY')
  if (bodyComp && bodyComp.text) {
    // Count {{1}}, {{2}} etc in body text
    const varMatches = bodyComp.text.match(/\{\{\d+\}\}/g) || []
    if (varMatches.length > 0) {
      const parameters = varMatches.map((_, i) => {
        const fieldName = variableMapping[String(i + 1)]
        let value = ''

        if (fieldName === 'first_name') value = contact.first_name || contact.name?.split(' ')[0] || ''
        else if (fieldName === 'name') value = contact.name || ''
        else if (fieldName === 'email') value = contact.email || ''
        else if (fieldName === 'phone') value = contact.phone || contact.wa_phone || ''
        else if (fieldName === 'location_name') value = 'UN1T'
        else if (fieldName) value = contact[fieldName] || fieldName  // Use as literal if not a field
        else value = ''

        return { type: 'text', text: value || ' ' }  // Meta rejects empty strings
      })

      components.push({ type: 'body', parameters })
    }
  }

  return components
}

/**
 * Get or create a conversation for a contact
 */
async function getOrCreateConversation(db, contact, locationId) {
  const { data: existing } = await db.from('whatsapp_conversations')
    .select('id')
    .eq('location_id', locationId)
    .eq('contact_id', contact.id)
    .single()

  if (existing) return existing.id

  const { data: created } = await db.from('whatsapp_conversations').insert({
    location_id: locationId,
    contact_id: contact.id,
    wa_phone: contact.wa_phone,
    status: 'active',
  }).select('id').single()

  return created?.id
}

/**
 * Check if a conversation is within the 24h window
 */
export function isWindowOpen(conversation) {
  if (!conversation?.window_expires_at) return false
  return new Date(conversation.window_expires_at) > new Date()
}

/**
 * Open/refresh the 24h window (called when we receive an inbound message)
 */
export async function refreshWindow(db, conversationId) {
  const now = new Date()
  const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000)

  await db.from('whatsapp_conversations').update({
    window_open_at: now.toISOString(),
    window_expires_at: expires.toISOString(),
  }).eq('id', conversationId)
}
