import { createServerClient } from './supabase'
import { applyAudienceFilter, applyAudienceFilterAsync } from './audience-filter'
import { getWhatsAppConfig, META_API_URL } from './whatsapp-config'
import {
  PER_TICK_MAX, AUTO_PAUSE_CONSECUTIVE_FAILURES,
  rollingHeadroom, selectDripRecipients, dripOutcome,
} from './whatsapp-drip.js'
import { getLocationBranding } from './location-branding'
import { extractNamedVariables } from './whatsapp-template-samples.js'

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

// AGENT-UX.1 — interactive tap-choice messages. Meta caps: quick-reply
// buttons max 3 / titles 20 chars; list messages max 10 rows / titles 24
// chars. The payload builder picks the right shape from the option count
// so callers never think about the split. Pure — exported for tests.
export function buildInteractivePayload(to, text, options) {
  const opts = (options || []).slice(0, 10)
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive' }
  if (opts.length <= 3) {
    return {
      ...base,
      interactive: {
        type: 'button',
        body: { text },
        action: {
          buttons: opts.map((o, i) => ({ type: 'reply', reply: { id: `opt_${i}`, title: String(o).slice(0, 20) } })),
        },
      },
    }
  }
  return {
    ...base,
    interactive: {
      type: 'list',
      body: { text },
      action: {
        button: 'Choose an option',
        sections: [{ rows: opts.map((o, i) => ({ id: `opt_${i}`, title: String(o).slice(0, 24) })) }],
      },
    },
  }
}

/**
 * Send a tap-choice interactive message (24h window only, same as text).
 * The customer's tap arrives at the webhook as type 'interactive' and is
 * already mapped to the button title — the agent sees it as plain text.
 */
export async function sendInteractiveOptions(to, text, options, opts = {}) {
  const config = await resolveConfig(opts)

  const response = await fetch(`${META_API_URL}/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: headersFor(config),
    body: JSON.stringify(buildInteractivePayload(to, text, options)),
  })

  const result = await response.json()
  if (result.error) {
    console.error('WhatsApp send error:', result.error)
    throw new Error(result.error.message || 'Failed to send WhatsApp interactive message')
  }

  return {
    messageId: result.messages?.[0]?.id,
    status: result.messages?.[0]?.message_status || 'sent',
  }
}

/**
 * Interactive Flow message (24h window). Launches a published Flow at `screen`.
 * flow_token round-trips to our data-exchange endpoint so it can resolve the
 * contact + location (minted as `<contactId>.<locationId>`).
 */
export function buildFlowPayload(to, { flowId, flowToken, flowCta, screen, data = {} }) {
  return {
    messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive',
    interactive: {
      type: 'flow',
      body: { text: 'Tap below to book your first visit.' },
      action: {
        name: 'flow',
        parameters: {
          mode: 'published', flow_message_version: '3', flow_token: flowToken, flow_id: flowId,
          flow_cta: flowCta || 'Book now', flow_action: 'navigate',
          flow_action_payload: { screen, data },
        },
      },
    },
  }
}

export async function sendFlowMessage(to, opts = {}) {
  const config = await resolveConfig(opts)
  const response = await fetch(`${META_API_URL}/${config.phoneNumberId}/messages`, {
    method: 'POST', headers: headersFor(config), body: JSON.stringify(buildFlowPayload(to, opts)),
  })
  const result = await response.json()
  if (result.error) {
    console.error('WhatsApp flow send error:', result.error)
    throw new Error(result.error.message || 'Failed to send WhatsApp flow message')
  }
  return { messageId: result.messages?.[0]?.id, status: result.messages?.[0]?.message_status || 'sent' }
}

// C3 — session cta_url message: a tappable, branded URL button instead of a
// raw pasted link (higher tap-through; opens in-chat webview). 24h window only,
// same as any session message.
export function buildCtaUrlPayload(to, { bodyText, buttonText, url }) {
  return {
    messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive',
    interactive: {
      type: 'cta_url',
      body: { text: bodyText },
      action: { name: 'cta_url', parameters: { display_text: buttonText, url } },
    },
  }
}

export async function sendCtaUrlMessage(to, { bodyText, buttonText, url }, opts = {}) {
  const config = await resolveConfig(opts)
  const response = await fetch(`${META_API_URL}/${config.phoneNumberId}/messages`, {
    method: 'POST', headers: headersFor(config), body: JSON.stringify(buildCtaUrlPayload(to, { bodyText, buttonText, url })),
  })
  const result = await response.json()
  if (result.error) {
    console.error('WhatsApp cta_url send error:', result.error)
    throw new Error(result.error.message || 'Failed to send WhatsApp link message')
  }
  return { messageId: result.messages?.[0]?.id, status: result.messages?.[0]?.message_status || 'sent' }
}

/**
 * If `text` ENDS with a single http(s) URL (optionally wrapped in trailing
 * punctuation/whitespace), split it: { body, url }. Returns null when the text
 * doesn't end in a URL, is ONLY a URL (no body left), or contains additional
 * URLs earlier (ambiguous — leave as plain text). Pure.
 */
export function splitTrailingUrl(text) {
  const s = String(text || '').trim()
  const m = s.match(/(https?:\/\/[^\s]+?)[)\].,!?]*$/)
  if (!m) return null
  const url = m[1]
  const body = s.slice(0, m.index).trim().replace(/[:\-–—]\s*$/, '').trim()
  if (!body) return null
  if (/(https?:\/\/)/.test(body)) return null // another URL earlier — ambiguous
  return { body, url }
}

// C4 — in-session media carousel (2-10 swipeable image cards, no template
// approval; 24h window only). Meta requires consistent button config across
// cards: all-or-none links, validated here and in the settings UI.
//
// Per-card mapping isolated in ONE pure function. Live-verified 2026-07-02:
// Meta requires a card-level `type` naming the card's button kind — omitting
// it fails with "violated JSON schema constraint 'required' ... missing:
// 'type'". Linked cards are `type: 'cta_url'` + the action block. Unlinked
// cards (no button) remain UNVERIFIED against live Meta — its docs describe
// one CTA button per card, so buttonless sets may be rejected outright; if an
// operator hits that, this function is still the only thing to change.
function buildCarouselCard(c, i) {
  return {
    card_index: i,
    ...(c.link_url ? { type: 'cta_url' } : {}),
    ...(c.title || c.body ? { body: { text: [c.title, c.body].filter(Boolean).join('\n') } } : {}),
    header: { type: 'image', image: { link: c.image_url } },
    ...(c.link_url ? { action: { name: 'cta_url', parameters: { display_text: (c.link_text || 'Open').slice(0, 20), url: c.link_url } } } : {}),
  }
}

export function buildMediaCarouselPayload(to, { bodyText, cards }) {
  const withLinks = cards.filter((c) => c.link_url)
  if (withLinks.length !== 0 && withLinks.length !== cards.length) {
    throw new Error('Carousel cards must all have a link, or none')
  }
  if (cards.length < 2 || cards.length > 10) throw new Error('Carousel needs 2-10 cards')
  return {
    messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive',
    interactive: {
      type: 'carousel',
      body: { text: bodyText },
      action: { cards: cards.map(buildCarouselCard) },
    },
  }
}

export async function sendMediaCarousel(to, { bodyText, cards }, opts = {}) {
  const config = await resolveConfig(opts)
  const response = await fetch(`${META_API_URL}/${config.phoneNumberId}/messages`, {
    method: 'POST', headers: headersFor(config), body: JSON.stringify(buildMediaCarouselPayload(to, { bodyText, cards })),
  })
  const result = await response.json()
  if (result.error) {
    console.error('WhatsApp carousel send error:', result.error)
    throw new Error(result.error.message || 'Failed to send WhatsApp carousel message')
  }
  return { messageId: result.messages?.[0]?.id, status: result.messages?.[0]?.message_status || 'sent' }
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
    // Full object server-side; code/subcode also ride the thrown
    // message because the Vercel log table truncates console output
    // (the embed-diagnostics lesson) and the operator-facing alert is
    // otherwise just Meta's useless generic text.
    console.error('WhatsApp template send error:', JSON.stringify(result.error))
    const codeSuffix = result.error.code
      ? ` (Meta code ${result.error.code}${result.error.error_subcode ? '/' + result.error.error_subcode : ''})`
      : ''
    throw new Error((result.error.message || 'Failed to send template message') + codeSuffix)
  }

  return {
    messageId: result.messages?.[0]?.id,
    status: result.messages?.[0]?.message_status || 'sent',
  }
}

/**
 * Send a media message (image, video, document, audio) — 24h window only.
 * `opts.voice: true` (audio only) renders a true voice note — mic icon,
 * sender avatar, waveform — instead of an audio-file card. Captions are
 * unsupported on audio either way.
 */
export async function sendMediaMessage(to, type, mediaUrl, caption, opts = {}) {
  const config = await resolveConfig(opts)

  const mediaTypes = {
    image: { image: { link: mediaUrl, caption } },
    video: { video: { link: mediaUrl, caption } },
    document: { document: { link: mediaUrl, caption, filename: caption || 'document' } },
    audio: { audio: opts.voice === true ? { link: mediaUrl, voice: true } : { link: mediaUrl } },
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
 * React to a message with an emoji (empty string removes the reaction).
 * Reactions only get a 'sent' status webhook — no delivered/read.
 */
export async function sendReaction(to, messageId, emoji, opts = {}) {
  const config = await resolveConfig(opts)

  const response = await fetch(`${META_API_URL}/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: headersFor(config),
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'reaction',
      reaction: { message_id: messageId, emoji: emoji || '' },
    }),
  })

  const result = await response.json()
  if (result.error) {
    console.error('WhatsApp reaction error:', result.error)
    throw new Error(result.error.message || 'Failed to send reaction')
  }

  return { messageId: result.messages?.[0]?.id }
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

/**
 * Mark an inbound message read AND show the "typing…" indicator (one Meta
 * call does both). The indicator auto-dismisses after ~25s or when the reply
 * lands. Per Meta guidance, only fire when a reply is actually coming — the
 * agent calls this after its reply gating + turn claim succeed.
 */
export async function sendTypingIndicator(messageId, opts = {}) {
  const config = await resolveConfig(opts)

  await fetch(`${META_API_URL}/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: headersFor(config),
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
      typing_indicator: { type: 'text' },
    }),
  })
}

/**
 * WA-BLOCK — block or unblock a WhatsApp user on this phone number (Meta Block
 * API). Blocked users can't message the number and it can't message them —
 * the inbox's spam/abuse action, which also protects the number's quality
 * rating. Meta only allows blocking users who messaged within the last 24h.
 */
export async function setWhatsAppUserBlockState(waPhone, blocked, opts = {}) {
  const config = await resolveConfig(opts)
  const response = await fetch(`${META_API_URL}/${config.phoneNumberId}/block_users`, {
    method: blocked ? 'POST' : 'DELETE',
    headers: headersFor(config),
    body: JSON.stringify({ messaging_product: 'whatsapp', block_users: [{ user: waPhone }] }),
  })
  const result = await response.json()
  if (result.error) {
    console.error('WhatsApp block API error:', result.error)
    throw new Error(result.error.message || 'Failed to update WhatsApp block state')
  }
  return result
}

/**
 * Configure Meta conversational components for this number: the welcome-message
 * event (request_welcome webhook) and up to 4 ice-breaker prompts (max 80 chars
 * each) shown to users opening a fresh chat.
 */
export async function setConversationalAutomation({ enableWelcome = true, prompts = [] }, opts = {}) {
  const config = await resolveConfig(opts)
  const response = await fetch(`${META_API_URL}/${config.phoneNumberId}/conversational_automation`, {
    method: 'POST',
    headers: headersFor(config),
    body: JSON.stringify({
      enable_welcome_message: !!enableWelcome,
      prompts: (prompts || []).map((p) => String(p).slice(0, 80)).filter(Boolean).slice(0, 4),
    }),
  })
  const result = await response.json()
  if (result.error) {
    console.error('WhatsApp conversational_automation error:', result.error)
    throw new Error(result.error.message || 'Failed to update chat openers')
  }
  return result
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
export async function createTemplate({ name, category, language, components, parameterFormat }, opts = {}) {
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
      // NAMED {{param}} templates must declare the format at create time;
      // POSITIONAL is Meta's default so we only send the flag when needed.
      ...(parameterFormat === 'NAMED' ? { parameter_format: 'NAMED' } : {}),
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

/**
 * Edit an existing template and resubmit it for review (WA-TMPL). Meta's edit
 * endpoint is POST /{template_id} with category + components — name and language
 * are immutable on edit. Allowed for REJECTED/PAUSED templates (the caller gates
 * this). On success Meta puts the template back into review (status → PENDING),
 * which arrives via the message_template_status_update webhook.
 */
export async function editTemplate(metaTemplateId, { category, components }, opts = {}) {
  const config = await resolveConfig(opts)

  const response = await fetch(`${META_API_URL}/${metaTemplateId}`, {
    method: 'POST',
    headers: headersFor(config),
    body: JSON.stringify({
      ...(category ? { category } : {}),
      components: components || [],
    }),
  })

  const result = await response.json()
  if (result.error) {
    console.error('Template edit error:', result.error)
    throw new Error(result.error.message || 'Failed to edit template')
  }

  return { success: result.success !== false }
}

// ============================================================
// AUDIENCE & BROADCAST
// ============================================================

/**
 * The WhatsApp broadcast reachability gate, as single-table predicates on
 * contacts (post mig 325: whatsapp_marketing is denormalized). Shared by the
 * send audience and the pre-send count so they agree by construction:
 * opted into WA marketing, has a normalized WA number, not blocked/opted-out.
 */
export function applyWhatsAppReachability(query) {
  return query
    .eq('whatsapp_marketing', true)
    .not('wa_phone', 'is', null)
    .neq('wa_status', 'blocked')
    .neq('wa_status', 'opted_out')
    .neq('wa_status', 'undeliverable')
}

/**
 * Reachability breakdown for an audience_filter at a location, as single-table
 * head:true counts on contacts (safe post mig 325). Shared by the pre-send
 * count endpoint and the persisted delivery_summary so the number the operator
 * sees before sending matches what actually goes out.
 *
 * Reason counts (no_number / no_consent / opted_out / undeliverable) are
 * independent and may overlap; the true excluded total is matched - reachable.
 *
 * @returns {Promise<{matched:number, reachable:number, excluded:{no_number:number,no_consent:number,opted_out:number,undeliverable:number}}>}
 */
export async function computeWhatsAppReachabilitySummary(db, filter, locationId) {
  const countOf = async (extra) => {
    const base = db.from('contacts').select('id', { count: 'exact', head: true }).eq('location_id', locationId)
    const { query } = await applyAudienceFilterAsync({ db, query: base, filter, locationId })
    const { count } = await (extra ? extra(query) : query)
    return count || 0
  }
  // Order matters — keep aligned with the test's call sequence.
  const matched = await countOf(null)
  const reachable = await countOf((q) => applyWhatsAppReachability(q))
  const no_number = await countOf((q) => q.is('wa_phone', null))
  const no_consent = await countOf((q) => q.eq('whatsapp_marketing', false))
  const opted_out = await countOf((q) => q.in('wa_status', ['blocked', 'opted_out']))
  const undeliverable = await countOf((q) => q.eq('wa_status', 'undeliverable'))
  return { matched, reachable, excluded: { no_number, no_consent, opted_out, undeliverable } }
}

// Recipient statuses that mean the message successfully left our system and was
// accepted by Meta. A message moves sent -> delivered -> read via status
// webhooks, so the cumulative "sent" tally must count all three — counting only
// 'sent' makes the number SHRINK as delivery receipts arrive.
export const DISPATCHED_STATUSES = ['sent', 'delivered', 'read']

// True when a send failure means the recipient is not a reachable WhatsApp
// account (permanent) — vs a transient/policy failure (rate limit, 24h
// re-engagement, frequency cap) which must NOT permanently exclude the contact.
// Meta surfaces "Message undeliverable" / error code 131026 for a number that
// isn't a WhatsApp user. We match that narrowly; everything else is retryable.
// The resulting wa_status='undeliverable' is reversible — an inbound message
// from the contact reactivates them (see the webhook inbound handler).
export function isUndeliverableError({ code, message } = {}) {
  if (code != null && String(code) === '131026') return true
  return /undeliverable/i.test(String(message || ''))
}

// Meta 131049: the recipient hit the CROSS-BUSINESS marketing frequency cap
// ("to maintain a healthy ecosystem engagement"). Temporary saturation, not a
// bad number — drips park these as 'capped' and retry after CAPPED_RETRY_HOURS.
export function isFrequencyCapError({ code, message } = {}) {
  if (code != null && String(code) === '131049') return true
  return /healthy ecosystem/i.test(String(message || ''))
}

export const CAPPED_RETRY_HOURS = 20

// A contact is flagged undeliverable after this many undeliverable failures.
// Operator policy (Richard, 2026-06-29): suppress on the FIRST undeliverable
// failure — stop marketing re-hitting a number that looks dead rather than
// waiting for a second strike. Meta's 131026 ("Message undeliverable") is an
// OVERLOADED code (besides "not a WhatsApp user" it can fire for transient
// frequency-capping / quality throttling), so one failure isn't *proof* a number
// is dead — accepted trade-off because the resulting wa_status='undeliverable'
// is REVERSIBLE: any inbound message from the contact reactivates them (see the
// webhook inbound handler). Only genuine 131026 / "undeliverable" failures count
// toward this — transient rate-limit / 24h-window errors are already excluded by
// isUndeliverableError(), so they never trip it.
export const UNDELIVERABLE_FAILURE_THRESHOLD = 1

// Flag a contact's number as undeliverable (not on WhatsApp) once it has hit
// UNDELIVERABLE_FAILURE_THRESHOLD permanent-looking send failures (now 1 — the
// first one), so future audiences skip it (applyWhatsAppReachability excludes
// wa_status='undeliverable'). Only flips an 'active' contact — never overrides
// an explicit opted_out/blocked, idempotent. Reversible: an inbound message
// reactivates the contact. Best-effort — must never throw into a send/webhook.
// The just-recorded failure row is included in the count (callers insert it
// before calling this), so at threshold 1 the triggering failure suffices.
export async function markUndeliverableIfPermanent(db, contactId, { code, message } = {}) {
  if (!contactId || !isUndeliverableError({ code, message })) return
  try {
    const { count } = await db.from('whatsapp_broadcast_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('contact_id', contactId)
      .eq('status', 'failed')
      .ilike('error_message', '%undeliverable%')
    if ((count || 0) < UNDELIVERABLE_FAILURE_THRESHOLD) return
    await db.from('contacts')
      .update({ wa_status: 'undeliverable' })
      .eq('id', contactId)
      .eq('wa_status', 'active')
  } catch (e) {
    console.error(`[wa] mark-undeliverable failed for contact ${contactId}:`, e?.message || e)
  }
}

/**
 * Build audience query for WhatsApp broadcasts. Single-table on contacts now
 * that whatsapp_marketing is denormalized (mig 325) — no contact_preferences
 * embed, so head:true counts over this gate are safe.
 */
function whatsAppAudienceBase(db, locationId) {
  return applyWhatsAppReachability(
    db.from('contacts').select('*').eq('location_id', locationId)
  )
}

export function buildWhatsAppAudience(db, filter, locationId) {
  // Apply user-supplied filters via the whitelisted helper. Throws
  // InvalidAudienceFilterError on unknown field or unsupported op.
  // Sync path skips virtual fields (event_registration / tag).
  return applyAudienceFilter(whatsAppAudienceBase(db, locationId), filter)
}

// Async sibling — resolves virtual fields (event_registration + tag) into
// the contacts.id constraint, then applies scalar filters. Returns the
// wrapped { query } so the caller can chain .order()/.range() (paged path)
// or await it directly (single-shot).
export async function buildWhatsAppAudienceAsync(db, filter, locationId) {
  return applyAudienceFilterAsync({ db, query: whatsAppAudienceBase(db, locationId), filter, locationId })
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
  while (true) {
    const end = Math.min(start + PAGE - 1, HARD_LIMIT - 1)
    // Rebuild the wrapped query each page (builders are single-use; mirrors
    // segment-sync.js). Re-resolves virtual fields per page — cheap for the
    // small registration/tag id sets, and keeps paging deterministic.
    const { query } = await buildWhatsAppAudienceAsync(db, filter, locationId)
    const { data: page, error } = await query
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
  // 'capped' rows (Meta frequency cap, 131049) re-open after this long — the
  // recipient is retried by a later tick instead of being done forever.
  const retryBefore = Date.now() - CAPPED_RETRY_HOURS * 60 * 60 * 1000
  const ids = []
  let start = 0
  while (true) {
    const end = Math.min(start + PAGE - 1, HARD_LIMIT - 1)
    const { data: page, error } = await db
      .from('whatsapp_broadcast_recipients')
      .select('contact_id, status, failed_at')
      .eq('broadcast_id', broadcastId)
      .order('contact_id', { ascending: true })
      .range(start, end)
    if (error) throw new Error(`Recipients query failed: ${error.message}`)
    if (!Array.isArray(page) || page.length === 0) break
    for (const r of page) {
      if (!r.contact_id) continue
      const retryable = r.status === 'capped' && r.failed_at && new Date(r.failed_at).getTime() <= retryBefore
      if (!retryable) ids.push(r.contact_id)
    }
    if (page.length < PAGE) break
    if (ids.length >= HARD_LIMIT) break
    start += PAGE
  }
  return ids
}

// AGENT-TAKEOVER — should Mia be paused on each recipient's thread for this
// send? True when the operator is personally managing the replies: an
// INDIVIDUAL targeted send (audience of 1 — a 1:1 message that just happens to
// use the broadcast machinery) always pauses; a BULK send pauses only when the
// operator opted in via handle_replies_manually. Pure — exported for tests.
export function shouldPauseAgentForBroadcast(broadcast, recipientCount) {
  return broadcast?.handle_replies_manually === true || recipientCount === 1
}

// Take Mia off a recipient's thread after an operator-managed send. Mirrors the
// manual-send take-over (agent/core.js manualTakeoverPatch): agent_active=false
// + a handoff stamp so it AUTO-re-arms after the cooldown (never permanent-off).
// Best-effort — a pause failure must never break the send.
async function pauseAgentOnThread(db, conversationId) {
  if (!conversationId) return
  try {
    await db.from('whatsapp_conversations')
      .update({ agent_active: false, agent_handed_off_at: new Date().toISOString() })
      .eq('id', conversationId)
      .eq('agent_active', true)
  } catch (e) {
    console.error('[wa] pause-agent-on-thread failed:', e?.message || e)
  }
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

  // Guard the entry state: only a draft (operator clicked Send) or a
  // 'sending' broadcast left mid-flight by an earlier crash may run.
  // Without this a second POST /send re-ran the WHOLE audience and
  // re-blasted everyone (the recipient insert was post-send and the table
  // had no unique key, so it couldn't even de-dupe the record).
  if (broadcast.status !== 'draft' && broadcast.status !== 'sending') {
    throw new Error(`Broadcast is in '${broadcast.status}' state — only draft / sending can be sent`)
  }

  // Compare-and-swap the draft→sending flip so two concurrent clicks can't
  // both start a pass — only the request that actually flips it proceeds.
  // A broadcast already 'sending' is a legitimate resume (the per-recipient
  // claim below de-dupes that path), so fall through.
  if (broadcast.status !== 'sending') {
    const { data: claimed } = await db.from('whatsapp_broadcasts')
      .update({ status: 'sending' })
      .eq('id', broadcastId)
      .eq('status', broadcast.status)
      .select('id')
    if (!claimed?.length) {
      return { sent: 0, failed: 0, total: 0, skipped: 'already-sending' }
    }
  }

  // WA-MULTI.1 — resolve the location's WA config ONCE upfront and
  // reuse for every recipient. Cheaper than re-resolving per-send;
  // also ensures the whole broadcast goes from one consistent
  // number even if someone reconfigures defaults mid-send.
  const broadcastConfig = await getWhatsAppConfig(broadcast.location_id)

  // Get audience — AUDIT P1-2: route the blast through the paginated
  // fetchAllWhatsAppAudience (the drip path already does) instead of awaiting
  // the builder once. Awaiting buildWhatsAppAudienceAsync directly capped the
  // blast at the PostgREST 1000-row limit, so a broadcast to a >1k audience
  // silently sent to only the first 1000 contacts. Same builder + columns, so
  // the per-contact shape (wa_phone, id) is unchanged. Throws on query error.
  const contacts = await fetchAllWhatsAppAudience(db, broadcast.audience_filter, broadcast.location_id)

  // Reachability snapshot for the record/list — best-effort. A count failure must
  // never abort the send (CLAUDE.md: side effects don't fail the primary response).
  let deliverySummary = null
  try {
    const summary = await computeWhatsAppReachabilitySummary(db, broadcast.audience_filter, broadcast.location_id)
    deliverySummary = { ...summary, reachable: contacts?.length || 0 }
  } catch (e) {
    console.error(`[broadcast ${broadcastId}] reachability summary failed:`, e?.message || e)
  }

  if (!contacts?.length) {
    await db.from('whatsapp_broadcasts').update({
      status: 'sent',
      sent_at: new Date().toISOString(),
      total_recipients: 0,
      delivery_summary: deliverySummary,
    }).eq('id', broadcastId)
    return { sent: 0, delivery_summary: deliverySummary }
  }

  // Resume support: skip contacts already recorded by a previous pass (a
  // crash mid-blast, or a retry). Paginated so a >1000-recipient broadcast
  // doesn't cap the done-set at 1000 and re-send the tail.
  const doneIds = new Set(await fetchDripDoneContactIds(db, broadcastId))
  const pending = contacts.filter(c => !doneIds.has(c.id))

  const template = broadcast.whatsapp_templates
  const variableMapping = broadcast.variable_mapping || {}
  const branding = await getLocationBranding(db, broadcast.location_id)
  let sentCount = 0
  let failedCount = 0

  // AGENT-TAKEOVER — an individual targeted send (audience of 1), or a bulk
  // send the operator opted to handle, pauses Mia on each recipient thread so
  // she doesn't reply over the operator when the recipient responds.
  const pauseAgent = shouldPauseAgentForBroadcast(broadcast, contacts.length)

  for (const contact of pending) {
    // Claim-first: insert the recipient row (status 'pending') BEFORE the
    // Meta send. The unique (broadcast_id, contact_id) constraint (mig 331)
    // makes this the per-recipient mutex — a concurrent pass that already
    // claimed this contact fails the insert and we skip, so the template
    // goes out exactly once even though doneIds was read before the race.
    const { error: claimErr } = await db.from('whatsapp_broadcast_recipients').insert({
      broadcast_id: broadcastId,
      contact_id: contact.id,
      status: 'pending',
    })
    if (claimErr) continue

    try {
      // Build template components with variable substitution
      const components = buildTemplateComponents(template, contact, variableMapping, broadcast.header_media_url, { companyName: branding.companyName, locationId: broadcast.location_id })

      const result = await sendTemplateMessage(
        contact.wa_phone,
        template.name,
        template.language,
        components,
        { config: broadcastConfig }
      )

      // Promote the claimed row to 'sent'. A DB hiccup here can't re-send.
      await db.from('whatsapp_broadcast_recipients').update({
        wa_message_id: result.messageId,
        status: 'sent',
        sent_at: new Date().toISOString(),
      }).eq('broadcast_id', broadcastId).eq('contact_id', contact.id)

      // Log to messages table
      const conversationId = await getOrCreateConversation(db, contact, broadcast.location_id)
      await db.from('whatsapp_messages').insert({
        conversation_id: conversationId,
        contact_id: contact.id,
        location_id: broadcast.location_id,
        wa_message_id: result.messageId,
        direction: 'outbound',
        message_type: 'template',
        template_name: template.name,
        template_variables: variableMapping,
        body: renderTemplateBody(template, contact, variableMapping, { companyName: branding.companyName }),
        status: 'sent',
        broadcast_id: broadcastId,
        sent_at: new Date().toISOString(),
      })
      // Operator-managed send → keep Mia off this thread.
      if (pauseAgent) await pauseAgentOnThread(db, conversationId)

      sentCount++
    } catch (err) {
      console.error(`Failed to send to ${contact.wa_phone}:`, err.message)

      // Promote the claimed row to 'failed' (it already exists from the
      // claim-first insert above).
      await db.from('whatsapp_broadcast_recipients').update({
        status: 'failed',
        error_message: err.message,
        failed_at: new Date().toISOString(),
      }).eq('broadcast_id', broadcastId).eq('contact_id', contact.id)

      // Permanently-undeliverable number (not on WhatsApp) → flag so future
      // audiences skip it. Reversible (inbound message reactivates). Best-effort.
      await markUndeliverableIfPermanent(db, contact.id, { message: err.message })

      failedCount++
    }

    // Rate limiting — Meta allows ~80 messages/second for verified businesses
    // Be conservative with a small delay
    if (sentCount % 50 === 0) {
      await new Promise(r => setTimeout(r, 1000))
    }
  }

  // Recompute cumulative metrics from the recipients table — a resumed
  // pass only sent the remainder, so sentCount/failedCount under-count.
  // Count everything dispatched (sent/delivered/read) as sent.
  const { count: cumulativeSent } = await db.from('whatsapp_broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId)
    .in('status', DISPATCHED_STATUSES)
  const { count: cumulativeFailed } = await db.from('whatsapp_broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId)
    .eq('status', 'failed')

  // Update broadcast metrics
  await db.from('whatsapp_broadcasts').update({
    status: 'sent',
    sent_at: new Date().toISOString(),
    total_recipients: contacts.length,
    total_sent: cumulativeSent || 0,
    total_failed: cumulativeFailed || 0,
    delivery_summary: deliverySummary,
  }).eq('id', broadcastId)

  // Update template send count (atomic; best-effort). Only THIS pass's
  // sends — a resume must not double-count rows a prior pass already added.
  try { await db.rpc('increment_whatsapp_template_sent', { p_template_id: template.id, p_delta: sentCount }) } catch {}

  return { sent: cumulativeSent || 0, failed: cumulativeFailed || 0, total: contacts.length, delivery_summary: deliverySummary }
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
    // Count everything DISPATCHED in the window, not just rows still in 'sent' —
    // a status webhook promoting sent→delivered→read must NOT free up headroom,
    // or the rolling-24h consumption under-counts and the drip exceeds daily_cap.
    .in('status', DISPATCHED_STATUSES)
    .gt('sent_at', since)
  const headroom = rollingHeadroom(broadcast.daily_cap, sentLast24h || 0)
  if (headroom <= 0) return { status: 'sending', skipped: 'no_headroom', headroom: 0, sent: 0, failed: 0 }

  // Eligible audience (paginated) minus already-processed, capped to this tick.
  const audience = await fetchAllWhatsAppAudience(db, broadcast.audience_filter, broadcast.location_id)
  if (audience.length === 0) {
    let deliverySummary = null
    try {
      const summary = await computeWhatsAppReachabilitySummary(db, broadcast.audience_filter, broadcast.location_id)
      deliverySummary = { ...summary, reachable: 0 }
    } catch (e) { console.error(`[drip ${broadcastId}] reachability summary failed:`, e?.message || e) }
    await db.from('whatsapp_broadcasts').update({
      status: 'sent', sent_at: new Date().toISOString(), total_recipients: 0,
      delivery_summary: deliverySummary,
    }).eq('id', broadcastId)
    return { status: 'sent', sent: 0, failed: 0, recipients: 0 }
  }
  const doneIds = await fetchDripDoneContactIds(db, broadcastId)
  // Per-drip burstiness override (mig 328) — falls back to the code default.
  const { toSend, exhausted } = selectDripRecipients({ audience, doneIds, headroom, perTickMax: broadcast.per_tick_max || perTickMax })

  if (toSend.length === 0) {
    if (exhausted) {
      // 'capped' rows (frequency cap, 131049) are still owed a retry — hold the
      // drip open so a later tick re-picks them once their park expires.
      const { count: cappedPending } = await db.from('whatsapp_broadcast_recipients')
        .select('id', { count: 'exact', head: true }).eq('broadcast_id', broadcastId).eq('status', 'capped')
      if ((cappedPending || 0) > 0) {
        return { status: 'sending', skipped: 'awaiting_capped_retry', capped: cappedPending, sent: 0, failed: 0 }
      }
      let deliverySummary = null
      try {
        const summary = await computeWhatsAppReachabilitySummary(db, broadcast.audience_filter, broadcast.location_id)
        deliverySummary = { ...summary, reachable: audience.length }
      } catch (e) { console.error(`[drip ${broadcastId}] reachability summary failed:`, e?.message || e) }
      await db.from('whatsapp_broadcasts').update({
        status: 'sent', sent_at: new Date().toISOString(), total_recipients: audience.length,
        delivery_summary: deliverySummary,
      }).eq('id', broadcastId)
      return { status: 'sent', sent: 0, failed: 0, recipients: audience.length }
    }
    return { status: 'sending', skipped: 'no_capacity', sent: 0, failed: 0 }
  }

  // Resolve the location's WA config once for the whole tick (as the blast does).
  const config = await getWhatsAppConfig(broadcast.location_id)
  const branding = await getLocationBranding(db, broadcast.location_id)
  const variableMapping = broadcast.variable_mapping || {}
  // AGENT-TAKEOVER — pause Mia on each recipient thread for an individual send
  // (audience of 1) or an opt-in bulk drip the operator is handling.
  const pauseAgent = shouldPauseAgentForBroadcast(broadcast, audience.length)
  let sent = 0, failed = 0, capped = 0, consecutiveFailures = 0, autoPaused = false

  for (const contact of toSend) {
    try {
      const components = buildTemplateComponents(template, contact, variableMapping, broadcast.header_media_url, { companyName: branding.companyName, locationId: broadcast.location_id })
      const result = await sendTemplateMessage(contact.wa_phone, template.name, template.language, components, { config })

      // Upsert (not insert): a contact retried after a 'capped' park has an
      // existing (broadcast, contact) row that this success must overwrite.
      await db.from('whatsapp_broadcast_recipients').upsert({
        broadcast_id: broadcastId, contact_id: contact.id,
        wa_message_id: result.messageId, status: 'sent', sent_at: new Date().toISOString(),
      }, { onConflict: 'broadcast_id,contact_id' })
      const conversationId = await getOrCreateConversation(db, contact, broadcast.location_id)
      await db.from('whatsapp_messages').insert({
        conversation_id: conversationId,
        contact_id: contact.id, location_id: broadcast.location_id,
        wa_message_id: result.messageId, direction: 'outbound', message_type: 'template',
        template_name: template.name, template_variables: variableMapping,
        body: renderTemplateBody(template, contact, variableMapping, { companyName: branding.companyName }),
        status: 'sent', broadcast_id: broadcastId, sent_at: new Date().toISOString(),
      })
      if (pauseAgent) await pauseAgentOnThread(db, conversationId)
      sent++; consecutiveFailures = 0
    } catch (err) {
      // Meta's cross-business per-user marketing frequency cap (131049) is a
      // SOFT failure: the user is temporarily saturated, not unreachable. Park
      // the row as 'capped' — fetchDripDoneContactIds re-opens it after
      // CAPPED_RETRY_HOURS so the next day's tick retries — and never let it
      // mark the number undeliverable or trip the auto-pause.
      if (isFrequencyCapError({ message: err.message })) {
        console.warn(`[drip ${broadcastId}] frequency-capped ${contact.wa_phone} — retrying next day`)
        await db.from('whatsapp_broadcast_recipients').upsert({
          broadcast_id: broadcastId, contact_id: contact.id,
          status: 'capped', error_message: err.message, failed_at: new Date().toISOString(),
        }, { onConflict: 'broadcast_id,contact_id' })
        capped++
        continue
      }
      console.error(`[drip ${broadcastId}] send to ${contact.wa_phone} failed:`, err.message)
      await db.from('whatsapp_broadcast_recipients').upsert({
        broadcast_id: broadcastId, contact_id: contact.id,
        status: 'failed', error_message: err.message, failed_at: new Date().toISOString(),
      }, { onConflict: 'broadcast_id,contact_id' })
      // Permanently-undeliverable number → flag so future audiences skip it.
      await markUndeliverableIfPermanent(db, contact.id, { message: err.message })
      failed++; consecutiveFailures++
      if (consecutiveFailures >= AUTO_PAUSE_CONSECUTIVE_FAILURES) { autoPaused = true; break }
    }
    // Same conservative rate-limit as the blast sender (~50/sec ceiling).
    if (sent % 50 === 0 && sent > 0) await new Promise(r => setTimeout(r, 1000))
  }

  // Cumulative totals from the recipients table. "Sent" = successfully dispatched,
  // which includes rows the status webhook has since moved to delivered/read —
  // counting only status='sent' makes the tally SHRINK as receipts arrive.
  const { count: totalSent } = await db.from('whatsapp_broadcast_recipients')
    .select('id', { count: 'exact', head: true }).eq('broadcast_id', broadcastId).in('status', DISPATCHED_STATUSES)
  const { count: totalFailed } = await db.from('whatsapp_broadcast_recipients')
    .select('id', { count: 'exact', head: true }).eq('broadcast_id', broadcastId).eq('status', 'failed')

  // We truly exhausted the audience only if we sent the last batch WITHOUT auto-
  // pausing partway (a pause leaves unsent contacts for the resume), and no
  // 'capped' rows are still owed a next-day retry.
  let cappedPending = 0
  if (exhausted && !autoPaused) {
    const { count } = await db.from('whatsapp_broadcast_recipients')
      .select('id', { count: 'exact', head: true }).eq('broadcast_id', broadcastId).eq('status', 'capped')
    cappedPending = count || 0
  }
  const reallyExhausted = exhausted && !autoPaused && (sent + failed + capped) >= toSend.length && cappedPending === 0
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
/**
 * WA-TMPL-SEND.1 — the media-header parameter for a template send,
 * or null when the template has no media header / no URL is known.
 * Shared by buildTemplateComponents (broadcasts + sequence steps) AND
 * the conversation send route, so a media-header template can never
 * again be sent header-less from any path (Meta rejects those with
 * the generic "unexpected error", not a clean validation message).
 * Pure — unit-tested in whatsapp-template-components.test.js.
 */
export function headerComponentFor(templateComponents, mediaUrl) {
  const headerComp = (templateComponents || []).find(c => c?.type === 'HEADER')
  if (!headerComp || !['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerComp.format) || !mediaUrl) {
    return null
  }
  const kind = headerComp.format.toLowerCase()
  return { type: 'header', parameters: [{ type: kind, [kind]: { link: mediaUrl } }] }
}

export function buildTemplateComponents(template, contact, variableMapping, headerMediaUrl, opts = {}) {
  const components = []
  const templateComponents = template.components || []

  // Check if template has a header with media. A media-header template
  // MUST be sent with a matching header parameter or Meta rejects the
  // send with (#132012) "Parameter format does not match format in the
  // created template" — so when the caller has no per-send override
  // (broadcast.header_media_url / step.whatsapp_header_media_url are
  // optional and usually null), fall back to the URL persisted on the
  // template row at upload time. This bit the first video-header
  // broadcast (2026-06-11): the template was APPROVED but the broadcast
  // carried no URL, the header param was silently omitted, and every
  // recipient failed.
  const mediaUrl = headerMediaUrl || template.header_media_url || null
  const headerComponent = headerComponentFor(templateComponents, mediaUrl)
  if (headerComponent) components.push(headerComponent)

  // Check if template has body variables
  const bodyComp = templateComponents.find(c => c.type === 'BODY')
  if (bodyComp && bodyComp.text) {
    const namedVars = extractNamedVariables(bodyComp.text)
    if (namedVars.length) {
      components.push({
        type: 'body',
        parameters: namedVars.map((n) => ({
          type: 'text',
          parameter_name: n,
          // mapping override wins; default: the param name IS the contact field.
          // Meta rejects empty strings — ' ' placeholder for blanks.
          text: resolveContactField((variableMapping || {})[n] || n, contact, opts) || ' ',
        })),
      })
    } else {
      const values = resolveTemplateVariableValues(template, contact, variableMapping, opts)
      if (values.length > 0) {
        components.push({
          type: 'body',
          // Meta rejects empty strings — ' ' placeholder for blanks.
          parameters: values.map((v) => ({ type: 'text', text: v || ' ' })),
        })
      }
    }
  }

  // FLOW-button templates: Meta requires a per-send button action parameter
  // (proven live: omitting it → 131009). Auto-attach the per-contact
  // flow_token when the caller supplies locationId (broadcast/drip paths);
  // callers that mint their own token (the welcome path) pass no locationId
  // and keep appending their own component.
  const buttonsComp = templateComponents.find(c => c.type === 'BUTTONS')
  const flowIdx = (buttonsComp?.buttons || []).findIndex(b => String(b.type || '').toUpperCase() === 'FLOW')
  if (flowIdx >= 0) {
    const flowToken = opts.flowToken || (contact?.id && opts.locationId ? `${contact.id}.${opts.locationId}` : null)
    if (flowToken) {
      components.push({ type: 'button', sub_type: 'flow', index: String(flowIdx), parameters: [{ type: 'action', action: { flow_token: flowToken } }] })
    }
  }

  return components
}

/**
 * Resolve a template's {{1}}..{{n}} body variables to concrete values
 * for one contact. Extracted from buildTemplateComponents so the same
 * resolution drives BOTH the send-time parameters and the rendered
 * body text we persist on whatsapp_messages (the inbox thread shows
 * what was actually sent instead of a "[template]" placeholder).
 */
export function resolveTemplateVariableValues(template, contact, variableMapping, opts = {}) {
  const bodyComp = (template.components || []).find(c => c.type === 'BODY')
  const varMatches = bodyComp?.text?.match(/\{\{\d+\}\}/g) || []
  return varMatches.map((_, i) => resolveContactField((variableMapping || {})[String(i + 1)], contact, opts))
}

/**
 * One contact field name → its concrete value for a send. Shared by the
 * positional ({{1}} + variableMapping) and NAMED ({{first_name}}) paths so
 * both resolve identically. Unknown names fall back to the literal string,
 * matching the historical positional behaviour.
 */
function resolveContactField(fieldName, contact, opts = {}) {
  if (!fieldName) return ''
  if (fieldName === 'first_name') return contact.first_name || contact.name?.split(' ')[0] || ''
  if (fieldName === 'name') return contact.name || ''
  if (fieldName === 'email') return contact.email || ''
  if (fieldName === 'phone') return contact.phone || contact.wa_phone || ''
  if (fieldName === 'location_name') return opts.companyName || 'UN1T'
  return contact[fieldName] || fieldName // literal fallback, as today
}

/** Positionally substitute {{n}} placeholders with resolved values. */
export function substituteTemplateBody(bodyText, values) {
  if (!bodyText) return null
  let i = 0
  return bodyText.replace(/\{\{\d+\}\}/g, () => {
    const v = values?.[i++]
    return v == null ? '' : String(v)
  })
}

/**
 * The human-readable text a template send produces for a contact —
 * persisted as whatsapp_messages.body so threads show real content.
 * Returns null when the template has no BODY text.
 */
export function renderTemplateBody(template, contact, variableMapping, opts = {}) {
  const bodyComp = (template.components || []).find(c => c.type === 'BODY')
  if (!bodyComp?.text) return null
  const namedVars = extractNamedVariables(bodyComp.text)
  if (namedVars.length) {
    // NAMED template: substitute each {{name}} with its resolved value
    // (mapping override wins; default: the param name IS the contact field).
    let text = bodyComp.text
    for (const n of namedVars) {
      const value = resolveContactField((variableMapping || {})[n] || n, contact, opts)
      text = text.replace(new RegExp(`\\{\\{\\s*${n}\\s*\\}\\}`, 'g'), value == null ? '' : String(value))
    }
    return text
  }
  return substituteTemplateBody(bodyComp.text, resolveTemplateVariableValues(template, contact, variableMapping, opts))
}

/**
 * Inbound consent keywords. The broadcast footer promises "Reply STOP
 * to Unsubscribe" — the webhook honours it via this parser. Twilio's
 * standard keyword set for stop; START/UNSTOP to opt back in. Only an
 * exact (trimmed, case-insensitive) match counts — "please stop
 * texting" is a conversation, not a command.
 */
export function parseConsentKeyword(text) {
  const t = String(text || '').trim().toLowerCase()
  if (['stop', 'stopall', 'stop all', 'unsubscribe', 'cancel', 'end', 'quit'].includes(t)) return 'stop'
  if (['start', 'unstop', 'subscribe'].includes(t)) return 'start'
  return null
}

/**
 * Get or create a conversation for a contact. Exported so the
 * sequence runner can attribute its outbound messages to the
 * right conversation row.
 */
export async function getOrCreateConversation(db, contact, locationId) {
  // The unique key on whatsapp_conversations is (location_id, wa_phone) —
  // NOT (location_id, contact_id) (mig 008). The inbound webhook also keys
  // on wa_phone. Looking up by contact_id could MISS a row the webhook
  // already created for this number (e.g. as an unknown sender, contact_id
  // still null), and the INSERT would then violate the wa_phone unique
  // constraint → null id → an orphaned outbound message not linked to the
  // thread. Key on wa_phone to match the constraint.
  const waPhone = contact.wa_phone
  if (waPhone) {
    const { data: existing } = await db.from('whatsapp_conversations')
      .select('id, contact_id')
      .eq('location_id', locationId)
      .eq('wa_phone', waPhone)
      .maybeSingle()
    if (existing) {
      // Backfill contact_id if the row was created for an unknown sender.
      if (!existing.contact_id && contact.id) {
        await db.from('whatsapp_conversations').update({ contact_id: contact.id }).eq('id', existing.id)
      }
      return existing.id
    }

    const { data: created, error } = await db.from('whatsapp_conversations').insert({
      location_id: locationId,
      contact_id: contact.id,
      wa_phone: waPhone,
      status: 'active',
    }).select('id').single()
    if (!error && created) return created.id

    // Lost a race with the inbound webhook (or another send) on the same
    // wa_phone — the unique constraint rejected us; re-read the winner.
    const { data: raced } = await db.from('whatsapp_conversations')
      .select('id')
      .eq('location_id', locationId)
      .eq('wa_phone', waPhone)
      .maybeSingle()
    return raced?.id
  }

  // No wa_phone (shouldn't happen for a WA send, but be safe) — fall back to
  // a contact_id lookup so we don't insert a duplicate NULL-wa_phone row.
  const { data: existing } = await db.from('whatsapp_conversations')
    .select('id')
    .eq('location_id', locationId)
    .eq('contact_id', contact.id)
    .maybeSingle()
  if (existing) return existing.id
  const { data: created } = await db.from('whatsapp_conversations').insert({
    location_id: locationId,
    contact_id: contact.id,
    wa_phone: null,
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
