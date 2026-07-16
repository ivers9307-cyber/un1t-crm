import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { refreshWindow, parseConsentKeyword, pickInboundContact, markUndeliverableIfPermanent } from '@/lib/whatsapp'
import { applyWhatsappConsentKeyword, applyMetaUserPreference } from '@/lib/whatsapp-consent'
import { handleFlowCompletion } from '@/lib/whatsapp-flow/completion.js'
import { resolveWhatsAppNumberByPhoneNumberId, classifyInboundOwner } from '@/lib/whatsapp-config'
import { verifyMetaSignature, safeEqual } from '@/lib/webhook-auth'
import { sendPush, sendPushToRolesAtLocation } from '@/lib/push'
import { MANAGER_ROLES } from '@/lib/schemas'
import { recordWebhookEvent, WEBHOOK_PROVIDERS } from '@/lib/webhook-events'
import { maybeAutoReply } from '@/lib/agent/auto-reply'
import { applyTemplateEvent } from '@/lib/whatsapp-template-events'
import { NUMBER_EVENT_FIELDS, applyNumberEvent } from '@/lib/whatsapp-number-events'
import { FLOW_EVENT_FIELDS, applyFlowEvent } from '@/lib/whatsapp-flow-events'
import { recordCtwaTouch } from '@/lib/meta-capi'
import { pricingColumnsFromStatus } from '@/lib/whatsapp-pricing'
import { ensureMediaRehosted } from '@/lib/whatsapp-media-server'
import { captureInboundBsuid } from '@/lib/whatsapp-bsuid'

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

  // Fail CLOSED: refuse if the App Secret isn't configured rather than
  // accept spoofable inbound (the agent now acts on these messages). 500
  // (not 403) so Meta retries for ~24h and recovery is just setting the
  // env var — mirrors the Postmark webhook posture.
  if (!appSecret) {
    console.error('[security] WHATSAPP_APP_SECRET is not set — refusing WhatsApp webhook (fail closed).')
    return NextResponse.json({ success: false, error: 'Server misconfigured' }, { status: 500 })
  }
  const result = verifyMetaSignature(rawBody, signature, appSecret)
  if (!result.ok) {
    console.warn(`WhatsApp webhook rejected: ${result.reason}`)
    return NextResponse.json({ success: false, error: 'Invalid signature' }, { status: 403 })
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

      const TEMPLATE_FIELDS = new Set([
        'message_template_status_update',
        'message_template_quality_update',
        'template_category_update',
      ])

      for (const change of changes) {
        if (TEMPLATE_FIELDS.has(change.field)) {
          await handleTemplateEvent(db, change.field, change.value)
          continue
        }
        if (NUMBER_EVENT_FIELDS.has(change.field)) {
          await handleNumberEvent(db, change.field, change.value)
          continue
        }
        if (FLOW_EVENT_FIELDS.has(change.field)) {
          await handleFlowEvent(db, change.value)
          continue
        }
        if (change.field === 'user_preferences') {
          // Meta's in-app "stop marketing messages" control — a consent signal
          // separate from STOP keywords. Best-effort per entry; never throws out.
          for (const pref of change.value?.user_preferences || []) {
            try { await applyMetaUserPreference(db, pref) }
            catch (e) { console.error('[wa-webhook] user_preferences failed:', e?.message) }
          }
          continue
        }
        if (change.field !== 'messages') continue

        const value = change.value
        const phoneNumberId = value.metadata?.phone_number_id

        // Handle incoming messages. Per-message idempotency
        // (mig 107) — Meta retries the entire envelope on non-2xx,
        // so each message.id is the natural dedup key. A retry
        // short-circuits the whole handleIncomingMessage call
        // before we double-insert into whatsapp_messages.
        if (value.messages) {
          for (const message of value.messages) {
            if (message?.id) {
              const dedup = await recordWebhookEvent({
                db, provider: WEBHOOK_PROVIDERS.WHATSAPP,
                eventId: `msg:${message.id}`,
              })
              if (dedup.seen) continue
            }
            await handleIncomingMessage(db, message, value.contacts, phoneNumberId)
          }
        }

        // Handle status updates (sent, delivered, read, failed).
        // Per (status.id, status.status) — same message id can
        // legitimately produce multiple status events, but each
        // (id, status) pair is unique from Meta.
        if (value.statuses) {
          for (const status of value.statuses) {
            if (status?.id && status?.status) {
              const dedup = await recordWebhookEvent({
                db, provider: WEBHOOK_PROVIDERS.WHATSAPP,
                eventId: `status:${status.id}:${status.status}`,
              })
              if (dedup.seen) continue
            }
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

async function handleIncomingMessage(db, message, contacts, phoneNumberId) {
  const senderPhone = message.from  // E.164 format
  const messageId = message.id
  const timestamp = message.timestamp ? new Date(parseInt(message.timestamp) * 1000) : new Date()

  // Get sender name from Meta's contacts array
  const metaContact = contacts?.find(c => c.wa_id === senderPhone)
  const senderName = metaContact?.profile?.name || null

  // WA-MULTI.1 / WA-TECHPROV.4 — route inbound to the location that
  // owns the recipient phone_number_id. Unknown ids are DROPPED
  // (cross-tenant protection); the env-config number and resolver
  // errors keep the historical first-location fallback.
  let routing = { action: 'first_location' }   // no phone_number_id in payload = legacy behaviour
  if (phoneNumberId) {
    try {
      const owningNumber = await resolveWhatsAppNumberByPhoneNumberId(phoneNumberId)
      routing = classifyInboundOwner(owningNumber)
    } catch (e) {
      console.warn('[wa-webhook] phone_number_id resolution failed (falling back):', e.message)
    }
  }
  if (routing.action === 'drop') {
    console.warn(`[wa-webhook] dropping inbound for unknown phone_number_id ${phoneNumberId}`)
    return
  }

  let defaultLocationId = routing.action === 'location' ? routing.locationId : null
  if (!defaultLocationId) {
    const { data: locations } = await db.from('locations').select('id').limit(1)
    if (locations?.length) defaultLocationId = locations[0].id
  }

  // Try to find existing contact by phone number
  // Meta sends phone without '+' (e.g. 353873147675), but contacts may store it
  // with '+' (e.g. +353873147675). Check both formats.
  const phoneWithPlus = senderPhone.startsWith('+') ? senderPhone : `+${senderPhone}`
  const phoneWithout = senderPhone.startsWith('+') ? senderPhone.slice(1) : senderPhone

  // COMMS-AUDIT 2026-07-10 — the phone can match contacts at SEVERAL
  // locations (multi-gym members, shared numbers). Prefer the contact in
  // the receiving number's location (resolved above); only fall back to a
  // cross-location match when none exists in-location, with an explicit
  // order (oldest contact first) so the fallback is deterministic instead
  // of Postgres row order. The matched contact's location still decides
  // the conversation's location below — this just stops a random
  // other-location contact hijacking a thread that belongs here.
  let contact = null
  const { data: existingContacts } = await db.from('contacts')
    .select('id, location_id')
    .or(`wa_phone.eq.${phoneWithout},wa_phone.eq.${phoneWithPlus},phone.eq.${phoneWithout},phone.eq.${phoneWithPlus}`)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(20)

  contact = pickInboundContact(existingContacts, defaultLocationId)
  if (contact) {
    // Ensure wa_phone is set on the contact (store without + to match Meta's format)
    await db.from('contacts')
      .update({ wa_phone: phoneWithout })
      .eq('id', contact.id)
      .is('wa_phone', null)

    // Reactivate a number previously flagged undeliverable — an inbound message
    // proves they're on WhatsApp. Only flips 'undeliverable' (never opted_out/blocked).
    await db.from('contacts')
      .update({ wa_status: 'active' })
      .eq('id', contact.id)
      .eq('wa_status', 'undeliverable')
  }

  // Determine location: contact's location wins if known (their
  // existing CRM placement), otherwise the WA-number owner, then
  // first-location fallback.
  const locationId = contact?.location_id || defaultLocationId

  // Get or create conversation (keyed by phone number, NOT by contact)
  const { data: existingConv } = await db.from('whatsapp_conversations')
    .select('id, contact_id, ctwa_clid')
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
      // CTWA backfill: the click id landed while the sender was unknown —
      // move it onto the newly linked contact (fires the Lead event once).
      if (existingConv.ctwa_clid) {
        await recordCtwaTouch(db, { ctwaClid: existingConv.ctwa_clid, conversationId: null, contact, locationId })
      }
    }
  } else {
    const { data: newConv } = await db.from('whatsapp_conversations').insert({
      location_id: locationId,
      contact_id: contact?.id || null,  // null if unknown sender
      wa_phone: senderPhone,
      wa_profile_name: senderName,
      status: 'active',
      // CTWA: a click-to-WhatsApp ad's first message carries referral.ctwa_clid
      ctwa_clid: message.referral?.ctwa_clid || null,
    }).select('id').single()
    conversationId = newConv?.id
  }

  if (!conversationId) {
    console.error('Could not create conversation for:', senderPhone)
    return
  }

  // CTWA attribution — stamp the click id (conversation + contact) and fire
  // the Lead conversion once. Swallows its own errors; never blocks the webhook.
  await recordCtwaTouch(db, { ctwaClid: message.referral?.ctwa_clid, conversationId, contact, locationId })

  // WA-BSUID.1 — capture Meta's Business-Scoped User ID (arrives as
  // contacts[].user_id once usernames roll out) onto the matched
  // conversation + contact. Capture ONLY — identity resolution above stays
  // phone-keyed. Best-effort: never overwrites a differing stored value
  // (warns — that's a collision signal) and never throws out of the webhook.
  await captureInboundBsuid(db, { contacts, senderPhone, conversationId, contactId: contact?.id || null })

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
  // WA-MEDIA.1 — inbound media arrives as a Meta media ID (not a URL).
  // Store it in media_external_id; the bytes are re-hosted into the
  // whatsapp-media bucket (eagerly below, lazily by /api/whatsapp/media).
  let mediaExternalId = null
  let mediaMime = null

  switch (messageType) {
    case 'text':
      body = message.text?.body || ''
      break
    case 'image':
      body = message.image?.caption || ''
      mediaExternalId = message.image?.id
      mediaMime = message.image?.mime_type
      break
    case 'video':
      body = message.video?.caption || ''
      mediaExternalId = message.video?.id
      mediaMime = message.video?.mime_type
      break
    case 'document':
      body = message.document?.caption || message.document?.filename || ''
      mediaExternalId = message.document?.id
      mediaMime = message.document?.mime_type
      break
    case 'audio':
      mediaExternalId = message.audio?.id
      mediaMime = message.audio?.mime_type
      break
    case 'location':
      body = `Location: ${message.location?.latitude}, ${message.location?.longitude}`
      break
    case 'contacts':
      body = `Shared contact: ${message.contacts?.[0]?.name?.formatted_name || 'Unknown'}`
      break
    case 'interactive':
      if (message.interactive?.type === 'nfm_reply') {
        // A completed WhatsApp Flow ("Book your first visit"). Book it, then log a marker.
        try { await handleFlowCompletion(db, { interactive: message.interactive, contact, locationId }) }
        catch (e) { console.error('[wa-webhook] flow completion failed:', e.message) }
        body = '[Booking submitted via WhatsApp Flow]'
      } else {
        body = message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || ''
      }
      break
    case 'reaction':
      body = `Reacted: ${message.reaction?.emoji || ''}`
      break
    case 'request_welcome':
      // C2 — the user opened a fresh chat (e.g. from a click-to-WhatsApp ad)
      // without typing. No content; the instant greeting is sent below.
      body = '[Opened the chat]'
      break
    default:
      body = `[${messageType} message]`
  }

  // Save message (contact_id is null for unknown senders)
  const { data: insertedMessage } = await db.from('whatsapp_messages').insert({
    conversation_id: conversationId,
    contact_id: contact?.id || null,
    location_id: locationId,
    wa_message_id: messageId,
    direction: 'inbound',
    message_type: messageType,
    body,
    media_external_id: mediaExternalId,
    media_mime_type: mediaMime,
    status: 'delivered',
    sent_at: timestamp.toISOString(),
  }).select('id').single()

  // Update conversation
  await db.from('whatsapp_conversations').update({
    last_message_at: timestamp.toISOString(),
    last_message_direction: 'inbound',
    last_message_preview: body?.substring(0, 100) || `[${messageType}]`,
    resolved_at: null,
    // AGENT-FOLLOWUP.1 — a reply ends the quiet-cycle: the ladder
    // starts fresh from this message.
    agent_followup_stage: 0,
  }).eq('id', conversationId)
  // Atomic unread bump (best-effort) — replaces the read-modify-write above.
  try { await db.rpc('increment_whatsapp_conversation_unread', { p_conversation_id: conversationId }) } catch {}

  // WA-MEDIA.1 — re-host inbound media into the whatsapp-media bucket now,
  // so the inbox shows it without a first-view round-trip and it survives
  // Meta's ~30-day media expiry. Best-effort and bounded: never block or
  // fail the webhook — /api/whatsapp/media re-hosts lazily if this misses.
  if (mediaExternalId && insertedMessage?.id) {
    try {
      await ensureMediaRehosted(db, {
        id: insertedMessage.id,
        location_id: locationId,
        message_type: messageType,
        media_mime_type: mediaMime,
        media_external_id: mediaExternalId,
        media_storage_path: null,
      })
    } catch (e) {
      console.error('[wa-webhook] inbound media rehost failed (will lazy-load):', e?.message)
    }
  }

  // Consent keywords — the broadcast footer promises "Reply STOP to
  // Unsubscribe", so honour an exact STOP/START text reply: flip
  // whatsapp_marketing + wa_status, write the consent_log audit row,
  // and acknowledge in-thread. Best-effort (the helper never throws);
  // unknown senders (no contact row) are skipped.
  if (messageType === 'text' && contact?.id) {
    const keyword = parseConsentKeyword(body)
    if (keyword) {
      await applyWhatsappConsentKeyword({
        db,
        contact,
        // The contact lookup above is a minimal select (no wa_phone) —
        // pass the sender's number from the webhook payload so the ack
        // can actually send.
        waPhone: phoneWithout,
        locationId,
        conversationId,
        keyword,
      })
    }
  }

  // RADAR-AGENT.0 — run the customer agent FIRST so we know whether it engaged
  // this message, then decide the inbound push. Gated OFF by default
  // (locations.settings.customer_agent) + test-mode allow-list; runs only on
  // text messages and never throws out of the webhook.
  // C2 — request_welcome (a chat opened without typing) must NOT reach the
  // agent: shouldAgentReply would treat it as an unsupported type and send the
  // soft-handoff acknowledgement to someone who hasn't said anything. The
  // open-event gets the instant greeting below instead.
  let agentResult = null
  if (messageType !== 'request_welcome') {
    try {
      agentResult = await maybeAutoReply(db, {
        conversationId,
        locationId,
        senderPhone,
        contactId: contact?.id || null,
        messageType,
        body,
        waMessageId: message.id || null,
      })
    } catch (err) {
      console.error('[whatsapp webhook] agent auto-reply failed', err?.message)
    }
  }

  // Push notification fan-out for inbound WhatsApp.
  //   - If the conversation is assigned to a specific user, push to them.
  //   - Otherwise push to owners + managers + head coaches at the location.
  // Per-user opt-in is gated by permissions.mobile.notify_whatsapp inside
  // sendPush(). Best-effort — never throw out of the webhook handler.
  // AGENT-ACTIVITY.1 — when the agent engaged (replied or handed off) it emits
  // its own debounced "chatting with Mia" ping to inbox staff, so SKIP this
  // generic per-message manager push to avoid double-notifying.
  const agentEngaged = agentResult?.handled === true &&
    ['reply', 'handoff', 'soft_handoff'].includes(agentResult.action)
  if (!agentEngaged) {
    try {
      const { data: conv } = await db.from('whatsapp_conversations')
        .select('assigned_to, location_id, contacts!contact_id(name, first_name, wa_profile_name)')
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
        await sendPush([conv.assigned_to], payload, { locationId: conv.location_id })
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

  // C2 — first-touch chat open (no typed message): greet instantly instead of
  // letting the agent treat it as an unsupported type.
  if (messageType === 'request_welcome') {
    try {
      const { maybeSendWelcomeGreeting } = await import('@/lib/agent/welcome-greeting')
      await maybeSendWelcomeGreeting(db, { conversationId, locationId, senderPhone, contactId: contact?.id || null })
    } catch (err) {
      console.error('[whatsapp webhook] welcome greeting failed', err?.message)
    }
  }
}

async function handleStatusUpdate(db, status) {
  const messageId = status.id
  const statusValue = status.status  // sent, delivered, read, played, failed
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
    case 'played':
      // Voice-note listened-to receipt — the strongest read signal there is.
      // Stored as read_at; status keeps the distinct 'played' value.
      updates.read_at = timestamp.toISOString()
      break
    case 'failed':
      updates.error_code = status.errors?.[0]?.code?.toString()
      updates.error_message = status.errors?.[0]?.title || 'Delivery failed'
      break
  }

  // WA-COST — the sent-status carries Meta's PMP pricing object; persist
  // category/type/billable (mig 341) so spend is attributable locally.
  const pricingPatch = pricingColumnsFromStatus(status)
  if (pricingPatch) Object.assign(updates, pricingPatch)

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
    // Prior recipient status — so counter adjustments fire once per real
    // transition (Meta may redeliver a status webhook).
    const { data: prevRecip } = await db.from('whatsapp_broadcast_recipients')
      .select('status')
      .eq('broadcast_id', msg.broadcast_id)
      .eq('contact_id', msg.contact_id)
      .maybeSingle()
    const prevStatus = prevRecip?.status

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

    // An async failure that means "not a WhatsApp number" → flag the contact so
    // future audiences skip it (reversible on inbound). Best-effort, never throws.
    if (statusValue === 'failed' && msg.contact_id) {
      await markUndeliverableIfPermanent(db, msg.contact_id, {
        code: status.errors?.[0]?.code,
        message: status.errors?.[0]?.title,
      })
    }

    // Update broadcast metrics — only on a genuine transition (guards
    // against Meta redelivering the same status and double-counting).
    if (prevStatus !== statusValue && ['delivered', 'read', 'failed'].includes(statusValue)) {
      const metricField = statusValue === 'delivered' ? 'total_delivered'
        : statusValue === 'read' ? 'total_read'
        : 'total_failed'

      // Atomic; best-effort — a counter must never break the status webhook.
      try {
        await db.rpc('increment_whatsapp_broadcast_metric', { p_broadcast_id: msg.broadcast_id, p_metric: metricField })
      } catch {}

      // A message counted as a successful send (total_sent = dispatched:
      // sent/delivered/read) that now FAILED must come back OUT of total_sent
      // or the "sent" figure permanently over-counts async failures.
      if (statusValue === 'failed' && ['sent', 'delivered', 'read'].includes(prevStatus)) {
        try {
          await db.rpc('increment_whatsapp_broadcast_metric', { p_broadcast_id: msg.broadcast_id, p_metric: 'total_sent', p_delta: -1 })
        } catch {}
      }
    }
  }
}

// WA-FLOW-HEALTH — a Flow status change (THROTTLED/BLOCKED = booking-funnel
// outage) pages managers at the owning location. Best-effort; never throws.
async function handleFlowEvent(db, value) {
  try {
    const { locations, notify } = await applyFlowEvent(db, value)
    if (!notify) return
    for (const locationId of locations) {
      await sendPushToRolesAtLocation(locationId, MANAGER_ROLES, {
        title: notify.title,
        body: notify.body,
        category: 'whatsapp',
        data: { type: 'flow_health', flow_id: String(value?.flow_id || '') },
      })
    }
  } catch (err) {
    console.error('[wa-webhook] flow event failed:', err?.message)
  }
}

// WA-HEALTH — number/account health webhooks (quality flags, limit tiers,
// display-name decisions, account restrictions) → whatsapp_numbers columns +
// manager push per affected location. Best-effort; never throws.
async function handleNumberEvent(db, field, value) {
  try {
    const { locations, notify } = await applyNumberEvent(db, field, value)
    if (!notify) return
    for (const locationId of locations) {
      await sendPushToRolesAtLocation(locationId, MANAGER_ROLES, {
        title: notify.title,
        body: notify.body,
        category: 'whatsapp', // rides the existing notify_whatsapp opt-in
        data: { type: 'number_health', field },
      })
    }
  } catch (err) {
    console.error('[wa-webhook] number event failed:', err?.message)
  }
}

// WA-TMPL — apply a template status/quality/category webhook to the row + audit
// trail, and push managers on meaningful transitions. Best-effort; never throws.
async function handleTemplateEvent(db, field, value) {
  try {
    const { template, notify } = await applyTemplateEvent(db, field, value)
    if (template && notify) {
      await sendPushToRolesAtLocation(template.location_id, MANAGER_ROLES, {
        title: notify.title,
        body: notify.body,
        category: 'whatsapp', // rides the existing notify_whatsapp opt-in
        data: { type: 'template_status', template_id: template.id },
      })
    }
  } catch (err) {
    console.error('[wa-webhook] template event failed:', err?.message)
  }
}
