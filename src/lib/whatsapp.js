import { createServerClient } from './supabase'
import { applyAudienceFilter } from './audience-filter'
import { getWhatsAppConfig, META_API_URL } from './whatsapp-config'
import {
  PER_TICK_MAX, AUTO_PAUSE_CONSECUTIVE_FAILURES,
  rollingHeadroom, selectDripRecipients, dripOutcome,
} from './whatsapp-drip.js'

// WA-MULTI.1 — config is now per-location. Resolution helper +
// env fallback live in whatsapp-config.js; the META_API_URL +
// version constants are re-exported from there for consistency.
//
// Every public function in this file takes an optional `opts`
// object as its last argument. Supported keys:
//
//   opts.locationId  — resolve credentials from whatsapp_numbers
//                       for this location. If no row exists, falls
//                       back to env vars (transitional backwards-
//                       compat). New callers should always pass.
//   opts.config      — pre-resolved config object (the caller
//                       already did the lookup, e.g. to send from
//                       a specific non-default number). When set,
//                       locationId is ignored.
//
// Calling with no opts → env vars only. Existing callers that
// haven't been updated yet keep working unchanged.

async function resolveConfig(opts = {}) {
  if (opts.config) return opts.config
  return await getWhatsAppConfig(opts.locationId || null)
}

function headersFor(config) {
  return {
    'Authorization': `Bearer ${config.token}`,
    'Content-Type': 'application/json',
  }
}

// ============================================================
// SEND MESSAGES
// ============================================================

/**
 * Send a text message (only works within 24h window).
 * Pass `opts.locationId` to route from a specific location's WA
 * number; omit for env-fallback (legacy single-number behaviour).
 */
export async function sendTextMessage(to, text, opts = {}) {
  const config = await resolveConfig(opts)

  const response = await fetch(`${META_API_URL}/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: headersFor(config),
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
export async function sendTemplateMessage(to, templateName, language = 'en', components = [], opts = {}) {
  const config = await resolveConfig(opts)

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

  const response = await fetch(`${META_API_URL}/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: headersFor(config),
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
export async function sendMediaMessage(to, type, mediaUrl, caption, opts = {}) {
  const config = await resolveConfig(opts)

  const mediaTypes = {
    image: { image: { link: mediaUrl, caption } },
    video: { video: { link: mediaUrl, caption } },
    document: { document: { link: mediaUrl, caption, filename: caption || 'document' } },
    audio: { audio: { link: mediaUrl } },
  }

  const response = await fetch(`${META_API_URL}/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: headersFor(config),
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
export async function markAsRead(messageId, opts = {}) {
  const config = await resolveConfig(opts)

  await fetch(`${META_API_URL}/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: headersFor(config),
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
 * Upload a media asset via Meta's Resumable Upload API and return the
 * `header_handle` ('h:...') string used in template approval payloads.
 *
 * Required env: WHATSAPP_APP_ID (the Meta App ID, NOT the business
 * account ID). The handle is ONLY useful for template approval —
 * runtime sends use a normal public media URL via the messaging API.
 *
 * Two-step protocol per Meta docs:
 *   1. POST {app-id}/uploads?file_length&file_type → { id: 'upload:...' }
 *   2. POST {upload-id} with binary body + file_offset header → { h: 'handle' }
 *
 * @param {Buffer} bytes
 * @param {string} mimeType
 * @returns {Promise<string>} the header handle to use in example.header_handle
 */
export async function uploadMediaForTemplate(bytes, mimeType, opts = {}) {
  const config = await resolveConfig(opts)
  const appId = config.appId || process.env.WHATSAPP_APP_ID
  if (!appId) {
    throw new Error('WhatsApp App ID is not configured. Set it on the location\'s WhatsApp number row or as WHATSAPP_APP_ID env var.')
  }

  // Step 1 — create upload session.
  const sessionRes = await fetch(
    `${META_API_URL}/${appId}/uploads?file_length=${bytes.length}&file_type=${encodeURIComponent(mimeType)}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}` },
    }
  )
  const sessionJson = await sessionRes.json()
  if (sessionJson.error || !sessionJson.id) {
    throw new Error(sessionJson.error?.message || 'Failed to start Meta upload session')
  }

  // Step 2 — POST the bytes against the session id. Auth header here
  // uses 'OAuth' scheme, NOT 'Bearer' — this is a Meta quirk for
  // the resumable upload endpoint specifically.
  const uploadRes = await fetch(`${META_API_URL}/${sessionJson.id}`, {
    method: 'POST',
    headers: {
      Authorization: `OAuth ${config.token}`,
      file_offset: '0',
      'Content-Type': mimeType,
    },
    body: bytes,
  })
  const uploadJson = await uploadRes.json()
  if (uploadJson.error || !uploadJson.h) {
    throw new Error(uploadJson.error?.message || 'Meta upload returned no handle')
  }
  return uploadJson.h
}

/**
 * Create a message template (submits to Meta for approval).
 * Note: templates are scoped to a WhatsApp Business Account, so
 * multi-number locations sharing one WABA share templates. The
 * config's businessAccountId drives the target WABA.
 */
export async function createTemplate({ name, category, language, components }, opts = {}) {
  const config = await resolveConfig(opts)
  if (!config.businessAccountId) {
    throw new Error('WhatsApp Business Account ID is not configured for this number.')
  }

  const response = await fetch(`${META_API_URL}/${config.businessAccountId}/message_templates`, {
    method: 'POST',
    headers: headersFor(config),
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
export async function getTemplates(limit = 100, opts = {}) {
  const config = await resolveConfig(opts)
  if (!config.businessAccountId) {
    throw new Error('WhatsApp Business Account ID is not configured for this number.')
  }

  const response = await fetch(
    `${META_API_URL}/${config.businessAccountId}/message_templates?limit=${limit}`,
    { headers: headersFor(config) }
  )

  const result = await response.json()
  if (result.error) throw new Error(result.error.message)

  return result.data || []
}

/**
 * Get a single template by name
 */
export async function getTemplate(templateName, opts = {}) {
  const config = await resolveConfig(opts)
  if (!config.businessAccountId) {
    throw new Error('WhatsApp Business Account ID is not configured for this number.')
  }

  const response = await fetch(
    `${META_API_URL}/${config.businessAccountId}/message_templates?name=${templateName}`,
    { headers: headersFor(config) }
  )

  const result = await response.json()
  if (result.error) throw new Error(result.error.message)

  return result.data?.[0] || null
}

/**
 * Delete a template
 */
export async function deleteTemplate(templateName, opts = {}) {
  const config = await resolveConfig(opts)
  if (!config.businessAccountId) {
    throw new Error('WhatsApp Business Account ID is not configured for this number.')
  }

  const response = await fetch(
    `${META_API_URL}/${config.businessAccountId}/message_templates?name=${templateName}`,
    { method: 'DELETE', headers: headersFor(config) }
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

  // Apply user-supplied filters via the whitelisted helper. Throws
  // InvalidAudienceFilterError on unknown field or unsupported op.
  return applyAudienceFilter(query, filter)
}

// Paginate the full WhatsApp-eligible audience (consent + opt-out + wa_phone + the
// operator's audience_filter). buildWhatsAppAudience awaited is capped at the
// project's 1000-row PostgREST limit, so a drip over a large lead list MUST page —
// the >1k pattern from pipeline-reclassify.js. Deterministic order by id so paging
// is stable. Rebuilds the query per page (builders are single-use).
export async function fetchAllWhatsAppAudience(db, filter, locationId) {
  const PAGE = 1000
  const HARD_LIMIT = 50_000
  const rows = []
  let start = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const end = Math.min(start + PAGE - 1, HARD_LIMIT - 1)
    const { data: page, error } = await buildWhatsAppAudience(db, filter, locationId)
      .order('id', { ascending: true })
      .range(start, end)
    if (error) throw new Error(`Audience query failed: ${error.message}`)
    if (!Array.isArray(page) || page.length === 0) break
    rows.push(...page)
    if (page.length < PAGE) break
    if (rows.length >= HARD_LIMIT) break
    start += PAGE
  }
  return rows
}

// Paginate the already-processed contact_ids for one broadcast (sent OR failed —
// both insert a recipients row, so both are skipped on resume). Also >1k-safe: a
// long-running drip accumulates thousands of recipient rows.
export async function fetchDripDoneContactIds(db, broadcastId) {
  const PAGE = 1000
  const HARD_LIMIT = 200_000
  const ids = []
  let start = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const end = Math.min(start + PAGE - 1, HARD_LIMIT - 1)
    const { data: page, error } = await db
      .from('whatsapp_broadcast_recipients')
      .select('contact_id')
      .eq('broadcast_id', broadcastId)
      .order('contact_id', { ascending: true })
      .range(start, end)
    if (error) throw new Error(`Recipients query failed: ${error.message}`)
    if (!Array.isArray(page) || page.length === 0) break
    for (const r of page) if (r.contact_id) ids.push(r.contact_id)
    if (page.length < PAGE) break
    if (ids.length >= HARD_LIMIT) break
    start += PAGE
  }
  return ids
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

  // WA-MULTI.1 — resolve the location's WA config ONCE upfront and
  // reuse for every recipient. Cheaper than re-resolving per-send;
  // also ensures the whole broadcast goes from one consistent
  // number even if someone reconfigures defaults mid-send.
  const broadcastConfig = await getWhatsAppConfig(broadcast.location_id)

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
        components,
        { config: broadcastConfig }
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
 * Send one cron tick's worth of a paced WhatsApp broadcast (WA-DRIP).
 *
 * Mirrors the blast sendBroadcast send loop but: (1) caps the tick to the rolling
 * -24h headroom and PER_TICK_MAX, (2) resumes via the recipients table, (3) auto-
 * pauses on a run of failures, (4) leaves the row 'sending' until the audience is
 * exhausted. The run-whatsapp-broadcasts cron gates the send window and only calls
 * this for delivery_mode='drip', status='sending', paused_at IS NULL.
 *
 * Concurrency: the 15-min cadence + a fast tick (<=100 sends) means two ticks for
 * the same drip never overlap, so pre-filtering done-ids is sufficient; the unique
 * (broadcast_id, contact_id) constraint is the belt-and-braces backstop.
 *
 * @param {string} broadcastId
 * @param {object} [opts]
 * @param {number} [opts.perTickMax=PER_TICK_MAX]
 * @returns {Promise<{status:string, sent:number, failed:number, recipients?:number, paused?:boolean, skipped?:string}>}
 */
export async function sendDripChunk(broadcastId, { perTickMax = PER_TICK_MAX } = {}) {
  const db = createServerClient()

  const { data: broadcast, error: bErr } = await db.from('whatsapp_broadcasts')
    .select('*, whatsapp_templates(*)')
    .eq('id', broadcastId)
    .single()
  if (bErr || !broadcast) throw new Error('Broadcast not found')
  if (broadcast.delivery_mode !== 'drip') throw new Error('Not a drip broadcast')
  if (broadcast.status !== 'sending') return { status: broadcast.status, skipped: 'not_sending', sent: 0, failed: 0 }
  if (broadcast.paused_at) return { status: 'sending', skipped: 'paused', sent: 0, failed: 0 }

  // Template gate — also covers Meta disabling a template mid-drip: auto-pause so
  // the operator notices rather than the list draining into template errors.
  const template = broadcast.whatsapp_templates
  if (!template || template.status !== 'APPROVED') {
    await db.from('whatsapp_broadcasts')
      .update({ paused_at: new Date().toISOString() })
      .eq('id', broadcastId)
    return { status: 'sending', skipped: 'template_not_approved', paused: true, sent: 0, failed: 0 }
  }

  // Rolling-24h headroom. head:true count — the .select() is the first one off
  // .from() so it reads the count option (see CLAUDE.md postgrest two-overload lesson).
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { count: sentLast24h } = await db.from('whatsapp_broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId)
    .eq('status', 'sent')
    .gt('sent_at', since)
  const headroom = rollingHeadroom(broadcast.daily_cap, sentLast24h || 0)
  if (headroom <= 0) return { status: 'sending', skipped: 'no_headroom', headroom: 0, sent: 0, failed: 0 }

  // Eligible audience (paginated) minus already-processed, capped to this tick.
  const audience = await fetchAllWhatsAppAudience(db, broadcast.audience_filter, broadcast.location_id)
  if (audience.length === 0) {
    await db.from('whatsapp_broadcasts').update({
      status: 'sent', sent_at: new Date().toISOString(), total_recipients: 0,
    }).eq('id', broadcastId)
    return { status: 'sent', sent: 0, failed: 0, recipients: 0 }
  }
  const doneIds = await fetchDripDoneContactIds(db, broadcastId)
  const { toSend, exhausted } = selectDripRecipients({ audience, doneIds, headroom, perTickMax })

  if (toSend.length === 0) {
    if (exhausted) {
      await db.from('whatsapp_broadcasts').update({
        status: 'sent', sent_at: new Date().toISOString(), total_recipients: audience.length,
      }).eq('id', broadcastId)
      return { status: 'sent', sent: 0, failed: 0, recipients: audience.length }
    }
    return { status: 'sending', skipped: 'no_capacity', sent: 0, failed: 0 }
  }

  // Resolve the location's WA config once for the whole tick (as the blast does).
  const config = await getWhatsAppConfig(broadcast.location_id)
  const variableMapping = broadcast.variable_mapping || {}
  let sent = 0, failed = 0, consecutiveFailures = 0, autoPaused = false

  for (const contact of toSend) {
    try {
      const components = buildTemplateComponents(template, contact, variableMapping, broadcast.header_media_url)
      const result = await sendTemplateMessage(contact.wa_phone, template.name, template.language, components, { config })

      await db.from('whatsapp_broadcast_recipients').insert({
        broadcast_id: broadcastId, contact_id: contact.id,
        wa_message_id: result.messageId, status: 'sent', sent_at: new Date().toISOString(),
      })
      await db.from('whatsapp_messages').insert({
        conversation_id: await getOrCreateConversation(db, contact, broadcast.location_id),
        contact_id: contact.id, location_id: broadcast.location_id,
        wa_message_id: result.messageId, direction: 'outbound', message_type: 'template',
        template_name: template.name, template_variables: variableMapping,
        status: 'sent', broadcast_id: broadcastId, sent_at: new Date().toISOString(),
      })
      sent++; consecutiveFailures = 0
    } catch (err) {
      console.error(`[drip ${broadcastId}] send to ${contact.wa_phone} failed:`, err.message)
      await db.from('whatsapp_broadcast_recipients').insert({
        broadcast_id: broadcastId, contact_id: contact.id,
        status: 'failed', error_message: err.message, failed_at: new Date().toISOString(),
      })
      failed++; consecutiveFailures++
      if (consecutiveFailures >= AUTO_PAUSE_CONSECUTIVE_FAILURES) { autoPaused = true; break }
    }
    // Same conservative rate-limit as the blast sender (~50/sec ceiling).
    if (sent % 50 === 0 && sent > 0) await new Promise(r => setTimeout(r, 1000))
  }

  // Cumulative totals from the recipients table.
  const { count: totalSent } = await db.from('whatsapp_broadcast_recipients')
    .select('id', { count: 'exact', head: true }).eq('broadcast_id', broadcastId).eq('status', 'sent')
  const { count: totalFailed } = await db.from('whatsapp_broadcast_recipients')
    .select('id', { count: 'exact', head: true }).eq('broadcast_id', broadcastId).eq('status', 'failed')

  // We truly exhausted the audience only if we sent the last batch WITHOUT auto-
  // pausing partway (a pause leaves unsent contacts for the resume).
  const reallyExhausted = exhausted && !autoPaused && (sent + failed) >= toSend.length
  const outcome = dripOutcome({ autoPaused, exhausted: reallyExhausted }, new Date().toISOString())

  await db.from('whatsapp_broadcasts').update({
    ...outcome,
    total_recipients: audience.length,
    total_sent: totalSent || 0,
    total_failed: totalFailed || 0,
  }).eq('id', broadcastId)

  return { status: outcome.status, paused: !!outcome.paused_at, sent, failed, recipients: audience.length }
}

/**
 * Build template components with contact-specific variable
 * substitution. Exported so the sequence runner can reuse the
 * exact same resolution logic used by broadcasts.
 */
export function buildTemplateComponents(template, contact, variableMapping, headerMediaUrl) {
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
 * Get or create a conversation for a contact. Exported so the
 * sequence runner can attribute its outbound messages to the
 * right conversation row.
 */
export async function getOrCreateConversation(db, contact, locationId) {
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
