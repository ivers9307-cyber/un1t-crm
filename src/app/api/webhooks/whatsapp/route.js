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
import { parseEchoMessages, parseSyncContacts, parseHistoryMessages, nextHistorySyncState, parseAccountUpdateEvent, nextCoexistenceLinkState, COEX_LINK_EVENTS } from '@/lib/whatsapp-coexistence'
import { syncContactMatchOnly, ingestCoexistenceMessage } from '@/lib/whatsapp-coexistence-ingest'

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
      const COEXISTENCE_EVENT_FIELDS = new Set(['smb_message_echoes', 'smb_app_state_sync', 'history'])

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
            try {
              const r = await applyMetaUserPreference(db, pref)
              // BAREWRITE.4 — `applied: false` is the ordinary answer for an
              // unknown category / unknown value / no matching contact, so
              // gate the log on `failures` (a write actually went wrong)
              // rather than on `applied`. Otherwise the real signal drowns.
              if (r?.failures?.length) {
                console.error(`[wa-webhook] user_preferences ${pref?.value} for contact ${r.contactId || 'unknown'} — ${r.applied ? 'applied only PARTIALLY' : 'NOT applied'}: ${r.failures.join('; ')}`)
              }
            }
            catch (e) { console.error('[wa-webhook] user_preferences failed:', e?.message) }
          }
          continue
        }
        if (COEXISTENCE_EVENT_FIELDS.has(change.field)) {
          try { await handleCoexistenceEvent(db, change.field, change.value) }
          catch (e) { console.error(`[wa-webhook] coexistence ${change.field} failed:`, e?.message) }
          continue
        }
        if (change.field === 'account_update') {
          // WA-COEX.6 — routed by WABA id (entry.id): account_update carries
          // NO metadata.phone_number_id, so the phone-number routing every
          // other branch uses cannot resolve it.
          try { await handleAccountUpdateEvent(db, entry.id, change.value) }
          catch (e) { console.error('[wa-webhook] account_update failed:', e?.message) }
          continue
        }
        if (change.field !== 'messages') continue

        const value = change.value
        const phoneNumberId = value.metadata?.phone_number_id

        // SAAS-2 — strict tenant routing: only an active whatsapp_numbers
        // row may own inbound traffic (messages AND statuses). A missing or
        // unknown phone_number_id, an env-only match (no location), or a
        // failed lookup DROPS the whole change with a structured log — the
        // old first-locations-row fallback routed a foreign number's
        // messages (and the contact + Mia reply they spawned) into an
        // arbitrary tenant. Still 200s below: Meta auto-disables webhooks
        // on non-2xx.
        let routing = { action: 'drop' }
        if (phoneNumberId) {
          try {
            routing = classifyInboundOwner(await resolveWhatsAppNumberByPhoneNumberId(phoneNumberId))
          } catch (e) {
            console.error(`[wa-webhook] DROP messages change: phone_number_id ${phoneNumberId} lookup failed: ${e.message}`)
            continue
          }
        }
        if (routing.action !== 'location') {
          console.error(`[wa-webhook] DROP messages change: unroutable phone_number_id ${phoneNumberId || '(missing)'} — no active whatsapp_numbers row`)
          continue
        }

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
            await handleIncomingMessage(db, message, value.contacts, routing.locationId)
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

// `defaultLocationId` is the location owning the recipient phone_number_id —
// already resolved (and unroutable traffic dropped) by the POST loop.
async function handleIncomingMessage(db, message, contacts, defaultLocationId) {
  const senderPhone = message.from  // E.164 format
  const messageId = message.id
  const timestamp = message.timestamp ? new Date(parseInt(message.timestamp) * 1000) : new Date()

  // Get sender name from Meta's contacts array
  const metaContact = contacts?.find(c => c.wa_id === senderPhone)
  const senderName = metaContact?.profile?.name || null

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
    // BAREWRITE.4 — every write in this handler is LOGGED, not surfaced and not
    // failed on. That is the correct handling for this file specifically: Meta
    // disables a subscription that stops returning 2xx, so nothing here may
    // refuse, and every one of these writes is bookkeeping whose loss costs a
    // record rather than a message. The rule is armed on this path anyway,
    // because "log it" is what makes a systematic failure visible at all — the
    // consent bug two functions down survived two audits precisely because its
    // writes looked handled and reported nothing.
    //
    // Ensure wa_phone is set on the contact (store without + to match Meta's format)
    const { error: phoneErr } = await db.from('contacts')
      .update({ wa_phone: phoneWithout })
      .eq('id', contact.id)
      .is('wa_phone', null)
    if (phoneErr) console.error(`[wa-webhook] wa_phone backfill failed for contact ${contact.id}:`, phoneErr.message)

    // Reactivate a number previously flagged undeliverable — an inbound message
    // proves they're on WhatsApp. Only flips 'undeliverable' (never opted_out/blocked).
    const { error: reactivateErr } = await db.from('contacts')
      .update({ wa_status: 'active' })
      .eq('id', contact.id)
      .eq('wa_status', 'undeliverable')
    if (reactivateErr) console.error(`[wa-webhook] undeliverable→active reactivation failed for contact ${contact.id} (future audiences will keep skipping them):`, reactivateErr.message)
  }

  // Determine location: contact's location wins if known (their
  // existing CRM placement), otherwise the WA-number owner.
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
      const { error: linkErr } = await db.from('whatsapp_conversations')
        .update({ contact_id: contact.id })
        .eq('id', conversationId)
      if (linkErr) console.error(`[wa-webhook] linking conversation ${conversationId} to contact ${contact.id} failed (the thread stays unattributed in the inbox):`, linkErr.message)
      // CTWA backfill: the click id landed while the sender was unknown —
      // move it onto the newly linked contact (fires the Lead event once).
      if (existingConv.ctwa_clid) {
        await recordCtwaTouch(db, { ctwaClid: existingConv.ctwa_clid, conversationId: null, contact, locationId })
      }
    }
  } else {
    const { data: newConv, error: convErr } = await db.from('whatsapp_conversations').insert({
      location_id: locationId,
      contact_id: contact?.id || null,  // null if unknown sender
      wa_phone: senderPhone,
      wa_profile_name: senderName,
      status: 'active',
      // CTWA: a click-to-WhatsApp ad's first message carries referral.ctwa_clid
      ctwa_clid: message.referral?.ctwa_clid || null,
    }).select('id').single()
    // SINGLEERR.1 — the guard below already caught the failure, but the REASON
    // was discarded, so an operator saw "could not create" with nothing to act
    // on. The error lives in the result object, not in a throw.
    if (convErr) {
      console.error('[whatsapp webhook] conversation insert failed:', convErr.message)
    }
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
    const { error: nameErr } = await db.from('whatsapp_conversations')
      .update({ wa_profile_name: senderName })
      .eq('id', conversationId)
    if (nameErr) console.error(`[wa-webhook] profile-name refresh failed for conversation ${conversationId}:`, nameErr.message)
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

  // WA-DEDUP.2 — second idempotency layer behind recordWebhookEvent, which
  // fails OPEN on any non-23505 DB error. idx_wa_messages_wa_id is a plain
  // (non-unique) index, so during a webhook_events blip a Meta retry would
  // re-insert this message and run a SECOND agent turn on it — Mia answering
  // the same inbound twice. Instagram gets this free from its unique
  // idx_ig_msg_mid. One indexed lookup per inbound.
  if (messageId) {
    const { data: alreadyStored } = await db.from('whatsapp_messages')
      .select('id')
      .eq('wa_message_id', messageId)
      .eq('direction', 'inbound')
      .limit(1)
      .maybeSingle()
    if (alreadyStored) return
  }

  // Save message (contact_id is null for unknown senders)
  const { data: insertedMessage, error: inboundInsertError } = await db.from('whatsapp_messages').insert({
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
  // Mirror recordAgentMessage's loud-failure posture: supabase-js returns
  // { error } without throwing, so an unchecked rejected insert (the
  // 2026-06-12 amnesia class) left the agent answering history that was
  // MISSING the message it was answering. Log it and skip the turn below;
  // the webhook still returns 200 (Meta disables hooks on non-2xx) and the
  // staff push still fires, so a human picks the thread up.
  if (inboundInsertError) {
    console.error('[wa-webhook] inbound message insert failed (agent turn skipped):', inboundInsertError.message, messageId)
  }

  // Update conversation
  const { error: convStampErr } = await db.from('whatsapp_conversations').update({
    last_message_at: timestamp.toISOString(),
    last_message_direction: 'inbound',
    last_message_preview: body?.substring(0, 100) || `[${messageType}]`,
    resolved_at: null,
    // AGENT-FOLLOWUP.1 — a reply ends the quiet-cycle: the ladder
    // starts fresh from this message.
    agent_followup_stage: 0,
  }).eq('id', conversationId)
  // A lost stamp leaves the thread looking answered and un-bumped in the
  // inbox's ordering — the message itself is already recorded above.
  if (convStampErr) console.error(`[wa-webhook] inbound conversation stamp failed for ${conversationId} (the thread will not rise in the inbox):`, convStampErr.message)
  // Atomic unread bump (best-effort) — replaces the read-modify-write above.
  // The try/catch is NOT the error handler: an rpc resolves with { error }
  // rather than throwing, so the destructure is what actually sees a failure.
  try {
    const { error: unreadErr } = await db.rpc('increment_whatsapp_conversation_unread', { p_conversation_id: conversationId })
    if (unreadErr) console.error(`[wa-webhook] unread bump failed for conversation ${conversationId}:`, unreadErr.message)
  } catch {}

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
  // and acknowledge in-thread. The helper never throws, and the webhook still
  // 200s either way (Meta disables a subscription on non-2xx) — but a REFUSED
  // opt-out is not a non-event: it means the customer asked to stop and is
  // still in every marketing audience, with no acknowledgement sent. Say so at
  // error level rather than discarding the result, which is what let the
  // never-firing catch inside the helper hide for so long.
  // Unknown senders (no contact row) are skipped.
  if (messageType === 'text' && contact?.id) {
    const keyword = parseConsentKeyword(body)
    if (keyword) {
      const consent = await applyWhatsappConsentKeyword({
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
      if (!consent?.applied) {
        console.error(`[wa-webhook] ${keyword.toUpperCase()} from contact ${contact.id} was NOT applied (${consent?.reason || 'unknown'}) — the contact is still in marketing audiences and got no acknowledgement: ${(consent?.failures || []).join('; ') || 'no detail'}`)
      } else if (consent.partial) {
        // BAREWRITE.4 — a PARTIAL opt-out is applied (at least one suppression
        // gate landed, which is why the customer was acknowledged) but it is
        // still a defect: say so at error level rather than letting a `true`
        // swallow it.
        console.error(`[wa-webhook] ${keyword.toUpperCase()} from contact ${contact.id} applied only PARTIALLY — one or more consent writes were lost: ${(consent.failures || []).join('; ')}`)
      }
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
  if (messageType !== 'request_welcome' && !inboundInsertError) {
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
  const { error: msgStatusErr } = await db.from('whatsapp_messages')
    .update(updates)
    .eq('wa_message_id', messageId)
  // A lost status write freezes the message at its previous state in the
  // inbox (a delivered message still reading 'sent'). Meta does not re-send a
  // status it has already delivered, so this is the only chance to record it.
  if (msgStatusErr) console.error(`[wa-webhook] message status write failed for ${messageId} (status ${statusValue} is lost — Meta will not resend it):`, msgStatusErr.message)

  // Update broadcast recipient if this was a broadcast message.
  // K8 — `.maybeSingle()`, not `.single()`: Meta sends status callbacks for
  // messages this system never recorded (anything sent on the number outside
  // the broadcast path), so "no row" is the ordinary case and must not be an
  // error we then discard. `wa_message_id` has no unique index — it is unique
  // in the live data but nothing enforces it — so a >1-row result stays an
  // anomaly worth logging rather than a silent null.
  const { data: msg, error: msgErr } = await db.from('whatsapp_messages')
    .select('broadcast_id, contact_id')
    .eq('wa_message_id', messageId)
    .maybeSingle()
  if (msgErr) console.error('[wa-webhook] status message lookup failed:', msgErr.message)

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

    const { error: recipErr } = await db.from('whatsapp_broadcast_recipients')
      .update(recipUpdates)
      .eq('broadcast_id', msg.broadcast_id)
      .eq('contact_id', msg.contact_id)
    // Reporting only — the recipient row's terminal state. Never re-sends.
    if (recipErr) console.error(`[wa-webhook] broadcast recipient status write failed (broadcast ${msg.broadcast_id}, contact ${msg.contact_id}) — the broadcast report will under-count:`, recipErr.message)

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
      // (The try/catch is not the error handler: an rpc resolves with
      // { error } rather than throwing. The destructure is.)
      try {
        const { error: metricErr } = await db.rpc('increment_whatsapp_broadcast_metric', { p_broadcast_id: msg.broadcast_id, p_metric: metricField })
        if (metricErr) console.error(`[wa-webhook] broadcast metric ${metricField} bump failed (broadcast ${msg.broadcast_id}):`, metricErr.message)
      } catch {}

      // A message counted as a successful send (total_sent = dispatched:
      // sent/delivered/read) that now FAILED must come back OUT of total_sent
      // or the "sent" figure permanently over-counts async failures.
      if (statusValue === 'failed' && ['sent', 'delivered', 'read'].includes(prevStatus)) {
        try {
          const { error: decErr } = await db.rpc('increment_whatsapp_broadcast_metric', { p_broadcast_id: msg.broadcast_id, p_metric: 'total_sent', p_delta: -1 })
          if (decErr) console.error(`[wa-webhook] total_sent decrement failed (broadcast ${msg.broadcast_id}) — the sent figure now permanently over-counts an async failure:`, decErr.message)
        } catch {}
      }
    }
  }
}

// WA-COEX.2 — coexistence webhook fields. Echoes = owner's phone-side sends
// (outbound, deduped). state_sync = contacts (match existing only). history =
// backfill (deduped). The number's owning location comes from phone_number_id;
// unknown ids are dropped, mirroring the messages path.
async function handleCoexistenceEvent(db, field, value) {
  const phoneNumberId = value?.metadata?.phone_number_id
  // SAAS-2 — same strict routing as the messages path: only an active
  // whatsapp_numbers row may own coexistence traffic. A missing/unknown
  // phone_number_id or a failed lookup DROPS the event with a structured
  // log (still 200) — the first-location fallback that used to catch
  // these landed a foreign number's echoes in an arbitrary tenant.
  let owner = null
  let routing = { action: 'drop' }
  if (phoneNumberId) {
    try {
      owner = await resolveWhatsAppNumberByPhoneNumberId(phoneNumberId)
      routing = classifyInboundOwner(owner)
    } catch (e) {
      console.error(`[wa-webhook] DROP coexistence ${field}: phone_number_id ${phoneNumberId} lookup failed: ${e?.message}`)
      return
    }
  }
  if (routing.action !== 'location') {
    console.error(`[wa-webhook] DROP coexistence ${field}: unroutable phone_number_id ${phoneNumberId || '(missing)'} — no active whatsapp_numbers row`)
    return
  }
  const locationId = routing.locationId

  if (field === 'smb_app_state_sync') {
    for (const c of parseSyncContacts(value)) {
      try { await syncContactMatchOnly(db, c) } catch (e) { console.error('[wa-webhook] sync contact failed:', e?.message) }
    }
    return
  }

  // echoes + history are both message descriptors; each deduped per wa_message_id.
  const ownPhone = owner?.displayPhone || null
  const descriptors = field === 'smb_message_echoes'
    ? parseEchoMessages(value)
    : parseHistoryMessages(value, ownPhone)
  for (const d of descriptors) {
    if (!d.waMessageId) continue
    const dedup = await recordWebhookEvent({ db, provider: WEBHOOK_PROVIDERS.WHATSAPP, eventId: `coex:${d.waMessageId}` })
    if (dedup.seen) continue
    try { await ingestCoexistenceMessage(db, { locationId, descriptor: d }) }
    catch (e) { console.error('[wa-webhook] coexistence ingest failed:', e?.message) }
  }

  if (field === 'history' && owner?.id) {
    try {
      const { data: row } = await db.from('whatsapp_numbers').select('signup_meta').eq('id', owner.id).maybeSingle()
      const meta = row?.signup_meta || {}
      const nextSync = nextHistorySyncState(meta.history_sync, value, new Date().toISOString())
      const { error: syncErr } = await db.from('whatsapp_numbers').update({ signup_meta: { ...meta, history_sync: nextSync } }).eq('id', owner.id)
      if (syncErr) console.error(`[wa-webhook] history-sync status update failed for number ${owner.id}:`, syncErr.message)
    } catch (e) { console.error('[wa-webhook] history-sync status update failed:', e?.message) }
  }
}

// WA-COEX.6 — coexistence link lifecycle (account_update).
//
// A client changing phone, reinstalling, or re-registering the WhatsApp
// Business app AUTO-OFFBOARDS our Cloud API companion. Sends for that number
// fail until Meta's automatic re-link lands (usually minutes, via a
// pre-checked opt-in the client sees while registering). Recording it — and
// telling the managers — is the difference between "WhatsApp is broken" and
// "the phone is re-registering, it'll be back shortly".
//
// Routed by WABA id: account_update carries NO metadata.phone_number_id, so
// the phone-number routing every other branch uses cannot resolve it. Scoped
// to source='coexistence' rows — a pure Cloud API number sharing the WABA is
// never offboarded this way and must not have its state flipped.
//
// NOTE: state only. We deliberately do NOT auto-block sends off the back of
// this: a state that got stuck 'offboarded' (a missed RECONNECTED) would mute
// a location's WhatsApp entirely, which is far worse than the handful of
// sends that fail during a minutes-long re-link. Revisit once we've seen the
// real event pair land — see docs/whatsapp-setup.md §5.
async function handleAccountUpdateEvent(db, wabaId, value) {
  const event = parseAccountUpdateEvent(value)
  if (event !== COEX_LINK_EVENTS.OFFBOARDED && event !== COEX_LINK_EVENTS.RECONNECTED) {
    // account_update is a SHARED field — it also carries account review,
    // violation, restriction and partner events. Not ours to act on, but
    // leave a breadcrumb rather than swallowing it silently.
    if (event) console.warn(`[wa-webhook] account_update ${event} ignored (waba ${wabaId || '(missing)'})`)
    return
  }
  if (!wabaId) {
    console.error(`[wa-webhook] DROP account_update ${event}: no WABA id on entry`)
    return
  }

  const { data: rows, error } = await db
    .from('whatsapp_numbers')
    .select('id, location_id, label, display_phone, signup_meta')
    .eq('business_account_id', String(wabaId))
    .eq('source', 'coexistence')
    .eq('is_active', true)
  if (error) {
    // supabase-js never throws — an unchecked error here would read as "no
    // numbers for this WABA" and the offboard would go unrecorded forever
    // (we 200, so Meta never retries).
    console.error(`[wa-webhook] account_update ${event}: whatsapp_numbers lookup failed: ${error.message}`)
    return
  }
  if (!rows?.length) {
    console.error(`[wa-webhook] DROP account_update ${event}: no active coexistence number for WABA ${wabaId}`)
    return
  }

  const nowIso = new Date().toISOString()
  for (const row of rows) {
    const meta = row.signup_meta || {}
    const prevStatus = meta.coex_link?.status || null
    const nextLink = nextCoexistenceLinkState(meta.coex_link, event, nowIso)

    const { error: writeErr } = await db
      .from('whatsapp_numbers')
      .update({ signup_meta: { ...meta, coex_link: nextLink } })
      .eq('id', row.id)
    if (writeErr) {
      console.error(`[wa-webhook] account_update ${event}: state write failed for ${row.id}: ${writeErr.message}`)
      continue
    }

    // Notify on TRANSITION only. Meta resends webhooks, and an unconditional
    // push would spam managers with "WhatsApp is offline" for an outage they
    // already know about.
    if (prevStatus === nextLink.status) continue
    const name = row.display_phone || row.label || 'WhatsApp number'
    const notify = event === COEX_LINK_EVENTS.OFFBOARDED
      ? {
          title: 'WhatsApp disconnected',
          body: `${name} was unlinked from the platform, usually because the WhatsApp Business app was reinstalled or re-registered on a new phone. Messages can't send until it finishes registering.`,
        }
      : {
          title: 'WhatsApp reconnected',
          body: `${name} is back online. Messaging has resumed.`,
        }
    try {
      await sendPushToRolesAtLocation(row.location_id, MANAGER_ROLES, {
        ...notify,
        category: 'whatsapp',
        data: { type: 'coex_link', event, number_id: String(row.id) },
      })
    } catch (e) {
      console.error('[wa-webhook] account_update push failed:', e?.message)
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
