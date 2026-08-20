import { createServerClient } from './supabase'
import { applyAudienceFilter, applyAudienceFilterAsync } from './audience-filter'
import { getWhatsAppConfig, META_API_URL } from './whatsapp-config'
import {
  PER_TICK_MAX, AUTO_PAUSE_CONSECUTIVE_FAILURES,
  rollingHeadroom, selectDripRecipients, dripOutcome,
} from './whatsapp-drip.js'
import { getSendBudget, blastBudgetBlockError, effectiveTickHeadroom } from './whatsapp-budget.js'
import { checkSpend } from './wallet-enforcement.js'
import { sliceBlastChunk } from './whatsapp-schedule.js'
import { getLocationFrequencyCap, isFrequencyCapped, stampMarketingTouch } from './frequency-cap.js'
import { getLocationBranding } from './location-branding'
import { extractNamedVariables } from './whatsapp-template-samples.js'
import { formatMetaError } from './whatsapp-meta-error.js'
import { dynamicUrlButtonIndex, urlButtonSendBlock, URL_BUTTON_MAPPING_KEY } from './whatsapp-template-buttons.js'
import { sendPushToRolesAtLocation } from './push'
import { MANAGER_ROLES } from './schemas'

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
 * Interactive Flow message (24h window). With a `screen` it `navigate`s straight
 * there (a static first screen); without one it uses `data_exchange`, so our
 * endpoint's INIT chooses the first screen — needed when the entry screen needs
 * live data (the class Day list is fetched on INIT). flow_token round-trips to the
 * endpoint so it can resolve the contact + location (`<contactId>.<locationId>`).
 */
export function buildFlowPayload(to, { flowId, flowToken, flowCta, screen, data = {}, bodyText }) {
  const actionParams = screen
    ? { flow_action: 'navigate', flow_action_payload: { screen, data } }
    : { flow_action: 'data_exchange' }
  return {
    messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive',
    interactive: {
      type: 'flow',
      body: { text: bodyText || 'Tap below to book your first visit.' },
      action: {
        name: 'flow',
        parameters: {
          mode: 'published', flow_message_version: '3', flow_token: flowToken, flow_id: flowId,
          flow_cta: flowCta || 'Book now', ...actionParams,
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
    // Meta's `message` here is the useless generic "Invalid parameter" —
    // formatMetaError digs out the title/user message that says what to fix.
    throw new Error(formatMetaError(result.error, 'Failed to create template'))
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
    throw new Error(formatMetaError(result.error, 'Failed to edit template'))
  }

  return { success: result.success !== false }
}

// ============================================================
// AUDIENCE & BROADCAST
// ============================================================

/**
 * The WhatsApp broadcast reachability gate, as single-table predicates on
 * contacts (post mig 422: whatsapp_marketing is denormalized). Shared by the
 * send audience and the pre-send count so they agree by construction:
 * opted into WA marketing, has a normalized WA number, not blocked/opted-out.
 */
export function applyWhatsAppReachability(query) {
  // LOCCOMMS.3 — gates on the VIEW's per-location consent column. Both call
  // sites below build on contact_location_audience (mig 491), so this is
  // always applied to the view, never to `contacts`.
  return query
    .eq('loc_whatsapp_marketing', true)
    .not('wa_phone', 'is', null)
    .neq('wa_status', 'blocked')
    .neq('wa_status', 'opted_out')
    .neq('wa_status', 'undeliverable')
}

/**
 * Reachability breakdown for an audience_filter at a location, as single-table
 * head:true counts on contacts (safe post mig 422). Shared by the pre-send
 * count endpoint and the persisted delivery_summary so the number the operator
 * sees before sending matches what actually goes out.
 *
 * Reason counts (no_number / no_consent / opted_out / undeliverable) are
 * independent and may overlap; the true excluded total is matched - reachable.
 *
 * FILTER-C.5 — `reachable` is built by the SEND builder itself
 * (buildWhatsAppAudienceAsync — the same function buildEligibleAudienceQuery
 * delegates to for this channel), not by re-applying the gates here. It used to
 * be the latter: the same five predicates, spelled at a second call site and
 * applied in a different order relative to the operator's filter. That is two
 * definitions of one number, which is how a pre-send count and a send drift
 * apart — FILTER-B.8 removed exactly this for SMS, whose three gates had been
 * hand-copied from sms.js. WhatsApp's extra gates are no obstacle: wa_status,
 * the wa_phone-presence test and the per-location consent column all live
 * INSIDE applyWhatsAppReachability, which the send builder already applies.
 * Template/session rules are not audience predicates (a broadcast sends a
 * template, so there is no 24h window to filter on), and the blast-time
 * frequency cap / resume set are decisions the sender makes over the rows this
 * query returns — the same shape of post-query gate every channel has.
 *
 * The `excluded` sub-counts below stay hand-built on purpose: they are
 * diagnostic breakdowns of WHY people fell out, not the number anything sends
 * on, and each one deliberately isolates a single reason.
 *
 * @returns {Promise<{matched:number, reachable:number, excluded:{no_number:number,no_consent:number,opted_out:number,undeliverable:number}}>}
 */
export async function computeWhatsAppReachabilitySummary(db, filter, locationId) {
  const countOf = async (extra) => {
    // LOCCOMMS.3 — per-location audience via the view (mig 491). Still a
    // single-table head:true count, which is what mig 422 made safe.
    const base = db.from('contact_location_audience').select('id', { count: 'exact', head: true }).eq('audience_location_id', locationId)
    const { query } = await applyAudienceFilterAsync({ db, query: base, filter, locationId })
    const { count } = await (extra ? extra(query) : query)
    return count || 0
  }
  // Order matters — keep aligned with the test's call sequence.
  const matched = await countOf(null)
  const { query: eligible } = await buildWhatsAppAudienceAsync(db, filter, locationId, {
    columns: 'id', selectOpts: { count: 'exact', head: true },
  })
  const { count: reachableCount } = await eligible
  const reachable = reachableCount || 0
  const no_number = await countOf((q) => q.is('wa_phone', null))
  const no_consent = await countOf((q) => q.eq('loc_whatsapp_marketing', false))
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

// WA-QUALITY.2 — blast preflight quality gate. A RED/FLAGGED number is one
// strike from a Meta messaging ban; blasting the whole list into it is how a
// number dies. Returns the operator-facing refusal, or null to proceed.
// GREEN/YELLOW/unknown (null — env config or never polled) pass. Pure.
export function broadcastQualityBlockError(qualityRating) {
  if (qualityRating !== 'RED' && qualityRating !== 'FLAGGED') return null
  return `This location's WhatsApp number quality is ${qualityRating} — sending paused to protect the number. ` +
    'Wait for the rating to recover in WhatsApp Manager before broadcasting again.'
}

// WA-QUALITY.4 — classify one blast send failure. Meta's cross-business
// frequency cap (131049) is temporary saturation of the RECIPIENT, not a bad
// number and not our problem: record it distinctly as 'capped' (never
// undeliverable) and keep it out of the circuit breaker. Everything else is a
// real failure that counts toward the consecutive-failure abort. Pure.
export function classifyBlastFailure({ code, message } = {}) {
  if (isFrequencyCapError({ code, message })) {
    return { recipientStatus: 'capped', countsTowardBreaker: false }
  }
  return { recipientStatus: 'failed', countsTowardBreaker: true }
}

// WA-QUALITY.3 — broadcast row patch when the blast circuit breaker trips.
// State choice: flip BACK to 'draft' (not a new status, not 'cancelled').
// The send route's draft→sending CAS is the only blast entry, so 'draft' is
// the one state an operator can re-send from without DB surgery; the resume
// pass skips every already-recorded recipient (fetchDripDoneContactIds), so
// pressing Send again only attempts the untouched remainder. paused_at +
// delivery_summary.aborted record why it stopped (cleared/overwritten when a
// later pass completes). Pure — unit-tested in whatsapp-drip-hardening.test.js.
export function blastAbortPatch({ deliverySummary, consecutiveFailures, lastError }, nowIso) {
  return {
    status: 'draft',
    paused_at: nowIso,
    delivery_summary: {
      ...(deliverySummary || {}),
      aborted: {
        reason: 'consecutive_send_failures',
        consecutive_failures: consecutiveFailures,
        last_error: lastError || null,
        at: nowIso,
      },
    },
  }
}

// Manager push for a tripped blast breaker. Pure.
export function blastAbortNotification(broadcast = {}, consecutiveFailures, lastError) {
  const name = broadcast.name ? `"${broadcast.name}"` : 'A WhatsApp broadcast'
  return {
    title: 'WhatsApp broadcast auto-stopped',
    body: `🚨 ${name} was stopped after ${consecutiveFailures} consecutive send failures` +
      `${lastError ? ` (last error: ${lastError})` : ''}. Already-sent messages are unaffected. ` +
      'Fix the number/token, then press Send again to deliver the remainder.',
  }
}

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
 * that whatsapp_marketing is denormalized (mig 422) — no contact_preferences
 * embed, so head:true counts over this gate are safe.
 */
function whatsAppAudienceBase(db, locationId, { columns = '*', selectOpts } = {}) {
  return applyWhatsAppReachability(
    // LOCCOMMS.3 — per-location audience via the view (mig 491).
    // FILTER-B.4 — columns/selectOpts are overridable so a count (head:true)
    // and a preview projection travel through THIS builder rather than a
    // parallel query. They must ride the FIRST select() after .from() or
    // postgrest-js silently drops them (buildAudienceQuery's CAMPAIGN.10 note).
    db.from('contact_location_audience').select(columns, selectOpts).eq('audience_location_id', locationId)
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
export async function buildWhatsAppAudienceAsync(db, filter, locationId, opts) {
  return applyAudienceFilterAsync({ db, query: whatsAppAudienceBase(db, locationId, opts), filter, locationId })
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

/**
 * CLAIM one drip recipient BEFORE the template goes out — the per-recipient
 * mutex, not just a dedupe.
 *
 * BAREWRITE.2 moved the drip's recipient write ahead of the send and said it
 * mirrored the blast sender. It did not: the blast INSERTs, so the UNIQUE
 * (broadcast_id, contact_id) constraint (mig 331) rejects a concurrent pass and
 * the template goes out exactly once. The drip UPSERTed, which succeeds on
 * conflict — so two overlapping cron ticks (Vercel cron does NOT skip an
 * overlapping run; campaign-sender.js documents that hazard) both "claimed" the
 * same contact and both sent. Dedupe across ticks, no mutex within them.
 *
 * The upsert was not gratuitous, which is why this is not a one-word revert: a
 * contact parked as 'capped' (Meta 131049) is deliberately re-selected by
 * fetchDripDoneContactIds after CAPPED_RETRY_HOURS, and by then a row EXISTS,
 * so a bare insert would fail and the retry would never send. Both properties
 * are kept by making each path its own CAS:
 *   • no row yet   → INSERT; the UNIQUE constraint is the mutex.
 *   • 'capped' row → UPDATE … WHERE status = 'capped' RETURNING id; the status
 *     transition is the mutex (whichever tick flips it first wins, the other
 *     matches zero rows and skips).
 * Any other existing status ('pending' / 'sent' / 'failed') means somebody else
 * holds the claim — skip, exactly as the blast does.
 *
 * @returns {Promise<{claimed: boolean, reason?: 'already_claimed'|string, retry?: boolean}>}
 */
export async function claimDripRecipient(db, broadcastId, contactId) {
  const { error: insertErr } = await db.from('whatsapp_broadcast_recipients').insert({
    broadcast_id: broadcastId,
    contact_id: contactId,
    status: 'pending',
  })
  if (!insertErr) return { claimed: true }
  if (!isUniqueViolation(insertErr)) return { claimed: false, reason: insertErr.message }

  const { data, error: retryErr } = await db.from('whatsapp_broadcast_recipients')
    .update({ status: 'pending', error_message: null, failed_at: null })
    .eq('broadcast_id', broadcastId)
    .eq('contact_id', contactId)
    .eq('status', 'capped')
    .select('id')
  if (retryErr) return { claimed: false, reason: retryErr.message }
  if (!Array.isArray(data) || data.length === 0) return { claimed: false, reason: 'already_claimed' }
  return { claimed: true, retry: true }
}

// Postgres unique_violation. Matched on the code, with the message as a
// fallback for clients that surface only prose.
function isUniqueViolation(error) {
  if (!error) return false
  if (error.code === '23505') return true
  return /duplicate key value|already exists/i.test(error.message || '')
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
 * Send a broadcast — template message to filtered audience.
 *
 * @param {string} broadcastId
 * @param {object} [opts]
 * @param {boolean} [opts.force=false]  WA-QUALITY.2 — bypass the number-quality
 *   preflight refusal (explicit operator override; the gate exists to protect
 *   the number, not to hard-lock it).
 * @param {number} [opts.maxRecipients]  WA-SCHEDULE — per-invocation recipient
 *   cap for cron-driven runs (mirrors the SMS engine's chunked-resume). When
 *   the pending audience exceeds it, this pass sends the first chunk and
 *   leaves the row 'sending'; the cron resumes the remainder next tick. The
 *   tier-budget preflight still evaluates the FULL pending audience, so
 *   chunking can never smuggle an over-budget blast past WA-BUDGET.1.
 *   Omitted (the operator /send route) → whole audience, behaviour unchanged.
 */
export async function sendBroadcast(broadcastId, { force = false, maxRecipients } = {}) {
  const db = createServerClient()

  // Get broadcast with template
  const { data: broadcast, error: bErr } = await db.from('whatsapp_broadcasts')
    .select('*, whatsapp_templates(*)')
    .eq('id', broadcastId)
    .single()

  if (bErr || !broadcast) throw new Error('Broadcast not found')
  if (!broadcast.whatsapp_templates) throw new Error('No template selected')
  if (broadcast.whatsapp_templates.status !== 'APPROVED') throw new Error('Template not approved by Meta')
  // A dynamic-URL template with no link value would fail per recipient at Meta
  // (132012), draining the list into errors. Refuse here — before the status
  // flip, like the wallet gate — so a refusal leaves the broadcast as it was.
  const urlSendBlock = urlButtonSendBlock(broadcast.whatsapp_templates, broadcast.variable_mapping || {})
  if (urlSendBlock) throw new Error(urlSendBlock)

  // Guard the entry state: only a draft (operator clicked Send) or a
  // 'sending' broadcast left mid-flight by an earlier crash may run.
  // Without this a second POST /send re-ran the WHOLE audience and
  // re-blasted everyone (the recipient insert was post-send and the table
  // had no unique key, so it couldn't even de-dupe the record).
  if (broadcast.status !== 'draft' && broadcast.status !== 'sending') {
    throw new Error(`Broadcast is in '${broadcast.status}' state — only draft / sending can be sent`)
  }

  // WA-MULTI.1 — resolve the location's WA config ONCE upfront and
  // reuse for every recipient. Cheaper than re-resolving per-send;
  // also ensures the whole broadcast goes from one consistent
  // number even if someone reconfigures defaults mid-send.
  // Resolved BEFORE the status flip so a refusal (quality gate below, or an
  // unconfigured location) leaves the broadcast in its entry state instead of
  // stranding it at 'sending'.
  const broadcastConfig = await getWhatsAppConfig(broadcast.location_id)

  // WA-QUALITY.2 — preflight quality gate: refuse to start (or resume) a blast
  // from a RED/FLAGGED number. Every blast entry funnels through this function,
  // so the gate covers them all; `force: true` is the explicit operator override.
  const qualityBlock = broadcastQualityBlockError(broadcastConfig.qualityRating)
  if (qualityBlock && !force) throw new Error(qualityBlock)

  // INTEG-C3 — per-location prepaid wallet gate (composes with, never
  // replaces, the Meta tier budget below — both apply): a tier-pinned
  // location whose monthly WhatsApp allowance is used up AND whose
  // wallet is empty pauses marketing blasts. Checked BEFORE the status
  // flip so a refusal leaves the broadcast in its entry state (same
  // posture as the quality gate); a scheduled blast's refusal is
  // caught by the cron, which pushes the managers. Unpinned locations
  // answer 'unpinned' → byte-identical old behaviour. Deliberately NOT
  // force-bypassable and FAIL-OPEN on any error (checkSpend never
  // throws; the try/catch is belt-and-braces per the C3 spec).
  let walletBlock = null
  try {
    const spend = await checkSpend(db, broadcast.location_id, 'wa_template_send', 'marketing')
    if (!spend.allow) {
      walletBlock = 'Monthly WhatsApp allowance is used up and the prepaid wallet is empty — marketing sends are paused. ' +
        'Top up the wallet, then press Send again to deliver this broadcast.'
    }
  } catch { /* fail open */ }
  if (walletBlock) throw new Error(walletBlock)

  // Compare-and-swap the draft→sending flip so two concurrent clicks can't
  // both start a pass — only the request that actually flips it proceeds.
  // A broadcast already 'sending' is a legitimate resume (the per-recipient
  // claim below de-dupes that path), so fall through. Clearing paused_at here
  // re-opens a breaker-aborted broadcast the operator re-sends (WA-QUALITY.3).
  if (broadcast.status !== 'sending') {
    const { data: claimed } = await db.from('whatsapp_broadcasts')
      .update({ status: 'sending', paused_at: null })
      .eq('id', broadcastId)
      .eq('status', broadcast.status)
      .select('id')
    if (!claimed?.length) {
      return { sent: 0, failed: 0, total: 0, skipped: 'already-sending' }
    }
  }

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
    return { status: 'sent', sent: 0, delivery_summary: deliverySummary }
  }

  // Resume support: skip contacts already recorded by a previous pass (a
  // crash mid-blast, or a retry). Paginated so a >1000-recipient broadcast
  // doesn't cap the done-set at 1000 and re-send the tail.
  const doneIds = new Set(await fetchDripDoneContactIds(db, broadcastId))
  const pending = contacts.filter(c => !doneIds.has(c.id))

  // FREQ-CAP.1 — cross-channel marketing frequency cap. Runs AFTER the
  // consent/reachability gate (applied by the audience query above) so a
  // suppressed contact is excluded there, never cap-deferred here. Capped
  // contacts (touched by ANY marketing channel inside the operator's
  // window) are dropped from THIS pass WITHOUT a recipient row: they are
  // not in doneIds, so a later pass (cron resume of a 'sending' blast, or
  // an operator re-send of a 'draft') re-evaluates and sends them once
  // their window clears. A blast that completes without them is accepted
  // — a blast is a point-in-time message; guaranteed eventual delivery is
  // drip territory. The count lands in delivery_summary for visibility.
  const capSetting = await getLocationFrequencyCap(db, broadcast.location_id)
  const eligible = capSetting.enabled
    ? pending.filter(c => !isFrequencyCapped(c, capSetting))
    : pending
  const capDeferredCount = pending.length - eligible.length
  if (deliverySummary && capDeferredCount > 0) {
    deliverySummary = { ...deliverySummary, frequency_capped: capDeferredCount }
  }

  // WA-BUDGET.1 — tier budget preflight: refuse to start a blast whose PENDING
  // audience (already-recorded recipients excluded, so a resume only needs
  // budget for the remainder) exceeds the number's remaining Meta daily
  // headroom. Deliberately NOT bypassed by `force` (unlike the quality gate) —
  // the tier is Meta's hard limit and over-tier sends hard-reject anyway.
  // Gated AFTER the pending count is known, so on refusal we un-strand the row
  // this call just flipped draft→sending; a 'sending' entry (crash resume)
  // stays 'sending' — re-running later is legitimate.
  const budget = await getSendBudget(db, { locationId: broadcast.location_id, tier: broadcastConfig.messagingLimitTier })
  const budgetBlock = blastBudgetBlockError(budget, pending.length)
  if (budgetBlock) {
    if (broadcast.status === 'draft') {
      await db.from('whatsapp_broadcasts').update({ status: 'draft' })
        .eq('id', broadcastId).eq('status', 'sending')
    }
    throw new Error(budgetBlock)
  }

  // WA-SCHEDULE — cap this pass to the caller's chunk AFTER the budget gate
  // (which deliberately saw the full pending set — INCLUDING cap-deferred
  // contacts, since a 'sending' resume may still deliver them later today
  // once their window clears; counting them keeps WA-BUDGET.1's "the whole
  // blast fits today's headroom" invariant conservative). Deferred
  // recipients stay unclaimed; the cron's resume pass picks them up next tick.
  const { batch, deferred } = sliceBlastChunk(eligible, maxRecipients)

  const template = broadcast.whatsapp_templates
  const variableMapping = broadcast.variable_mapping || {}
  // A dynamic-URL template with no link value set would fail per recipient at
  // Meta — refuse the whole send instead, the way the budget gate does above.
  const urlBlock = urlButtonSendBlock(template, variableMapping)
  if (urlBlock) throw new Error(urlBlock)
  const branding = await getLocationBranding(db, broadcast.location_id)
  let sentCount = 0
  let failedCount = 0
  // WA-QUALITY.3 — circuit breaker mirroring the drip's auto-pause: a run of
  // consecutive hard failures (dead token, banned number) aborts the loop
  // instead of draining the whole audience into failures.
  let consecutiveFailures = 0
  let abortedAfterFailures = 0
  let lastErrorMessage = null
  // FREQ-CAP.1 — successful sends get their marketing-touch stamp in one
  // batch after the loop (stamped even while the cap is disabled).
  const sentContactIds = []

  // AGENT-TAKEOVER — an individual targeted send (audience of 1), or a bulk
  // send the operator opted to handle, pauses Mia on each recipient thread so
  // she doesn't reply over the operator when the recipient responds.
  const pauseAgent = shouldPauseAgentForBroadcast(broadcast, contacts.length)

  for (const contact of batch) {
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
      sentContactIds.push(contact.id)
      consecutiveFailures = 0
    } catch (err) {
      console.error(`Failed to send to ${contact.wa_phone}:`, err.message)

      // WA-QUALITY.4 — a frequency-capped recipient (131049) is parked as
      // 'capped', never marked undeliverable, and doesn't count toward the
      // breaker. No blast retry machinery (that's drip territory): the row is
      // just recorded distinctly instead of being lumped into 'failed' — on a
      // re-send the claim-first insert conflicts and skips it, so it is
      // attempted at most once per blast.
      const { recipientStatus, countsTowardBreaker } = classifyBlastFailure({ message: err.message })

      // Promote the claimed row (it already exists from the claim-first
      // insert above).
      await db.from('whatsapp_broadcast_recipients').update({
        status: recipientStatus,
        error_message: err.message,
        failed_at: new Date().toISOString(),
      }).eq('broadcast_id', broadcastId).eq('contact_id', contact.id)

      if (!countsTowardBreaker) continue

      // Permanently-undeliverable number (not on WhatsApp) → flag so future
      // audiences skip it. Reversible (inbound message reactivates). Best-effort.
      await markUndeliverableIfPermanent(db, contact.id, { message: err.message })

      failedCount++
      consecutiveFailures++
      if (consecutiveFailures >= AUTO_PAUSE_CONSECUTIVE_FAILURES) {
        abortedAfterFailures = consecutiveFailures
        lastErrorMessage = err.message
        break
      }
    }

    // Rate limiting — Meta allows ~80 messages/second for verified businesses
    // Be conservative with a small delay
    if (sentCount % 50 === 0) {
      await new Promise(r => setTimeout(r, 1000))
    }
  }

  // FREQ-CAP.1 — stamp the marketing touch for everyone this pass reached
  // (blasts are marketing by definition: the audience gate requires
  // whatsapp_marketing consent). Best-effort inside the helper; stamped
  // regardless of whether the cap is enabled so enabling later has history.
  await stampMarketingTouch(db, sentContactIds)

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

  // Update template send count (atomic; best-effort). Only THIS pass's
  // sends — a resume must not double-count rows a prior pass already added.
  try { await db.rpc('increment_whatsapp_template_sent', { p_template_id: template.id, p_delta: sentCount }) } catch {}

  // WA-QUALITY.3 — breaker tripped: park the broadcast back at 'draft' with
  // the abort recorded (see blastAbortPatch for the state-machine rationale),
  // page the location managers, and leave every already-sent recipient as-is.
  if (abortedAfterFailures > 0) {
    const abortPatch = blastAbortPatch({
      deliverySummary,
      consecutiveFailures: abortedAfterFailures,
      lastError: lastErrorMessage,
    }, new Date().toISOString())

    await db.from('whatsapp_broadcasts').update({
      ...abortPatch,
      total_recipients: contacts.length,
      total_sent: cumulativeSent || 0,
      total_failed: cumulativeFailed || 0,
    }).eq('id', broadcastId)

    // Manager push — best-effort, never fails the abort handling.
    try {
      const notify = blastAbortNotification(broadcast, abortedAfterFailures, lastErrorMessage)
      await sendPushToRolesAtLocation(broadcast.location_id, MANAGER_ROLES, {
        title: notify.title,
        body: notify.body,
        category: 'whatsapp', // rides the existing notify_whatsapp opt-in
        data: { type: 'broadcast_aborted', broadcast_id: broadcastId },
      })
    } catch (e) {
      console.error(`[broadcast ${broadcastId}] abort push failed:`, e?.message || e)
    }

    return {
      status: 'draft',
      sent: cumulativeSent || 0,
      failed: cumulativeFailed || 0,
      total: contacts.length,
      aborted: true,
      abort_reason: `stopped after ${abortedAfterFailures} consecutive send failures`,
      delivery_summary: abortPatch.delivery_summary,
    }
  }

  // WA-SCHEDULE — chunked pass with a remainder: park the row at 'sending'
  // with fresh cumulative metrics and let the cron's resume arm finish it
  // next tick. paused_at untouched (it is null on this path — a breaker
  // abort took the early return above).
  if (deferred > 0) {
    await db.from('whatsapp_broadcasts').update({
      status: 'sending',
      total_recipients: contacts.length,
      total_sent: cumulativeSent || 0,
      total_failed: cumulativeFailed || 0,
      delivery_summary: deliverySummary,
    }).eq('id', broadcastId)
    return {
      status: 'sending',
      sent: cumulativeSent || 0,
      failed: cumulativeFailed || 0,
      total: contacts.length,
      remaining: deferred,
      delivery_summary: deliverySummary,
    }
  }

  // Update broadcast metrics. paused_at cleared: a completed pass supersedes
  // any earlier breaker abort (WA-QUALITY.3).
  await db.from('whatsapp_broadcasts').update({
    status: 'sent',
    sent_at: new Date().toISOString(),
    paused_at: null,
    total_recipients: contacts.length,
    total_sent: cumulativeSent || 0,
    total_failed: cumulativeFailed || 0,
    delivery_summary: deliverySummary,
  }).eq('id', broadcastId)

  return { status: 'sent', sent: cumulativeSent || 0, failed: cumulativeFailed || 0, total: contacts.length, delivery_summary: deliverySummary }
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
  // Same posture for a dynamic-URL template with no link value: pause rather
  // than throw, so the cron doesn't error-loop every tick, and the operator
  // sees a paused broadcast instead of a drained list of 132012s.
  if (urlButtonSendBlock(template, broadcast.variable_mapping || {})) {
    await db.from('whatsapp_broadcasts')
      .update({ paused_at: new Date().toISOString() })
      .eq('id', broadcastId)
    return { status: 'sending', skipped: 'url_button_value_missing', paused: true, sent: 0, failed: 0 }
  }

  // Resolve the location's WA config once for the whole tick (as the blast
  // does). Resolved up here (moved from below the recipient selection) because
  // the tier-budget layer needs config.messagingLimitTier before sizing the tick.
  const config = await getWhatsAppConfig(broadcast.location_id)

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
  const capHeadroom = rollingHeadroom(broadcast.daily_cap, sentLast24h || 0)
  if (capHeadroom <= 0) return { status: 'sending', skipped: 'no_headroom', headroom: 0, sent: 0, failed: 0 }

  // WA-BUDGET.2 — layer the GLOBAL cross-sender tier budget on top of the
  // per-broadcast daily_cap above: that cap only counts THIS broadcast's
  // recipients, so two concurrent drips (or a drip beside a blast/sequence
  // spike) could jointly blow the number's Meta tier. The tick is capped to
  // whatever the tier has left; a fully-spent tier parks the drip until
  // earlier sends age out of the rolling 24h window (no pause needed — the
  // next tick re-checks). Ungated tier (null budget) changes nothing.
  const budget = await getSendBudget(db, { locationId: broadcast.location_id, tier: config.messagingLimitTier })
  const headroom = effectiveTickHeadroom(capHeadroom, budget)
  if (headroom <= 0) return { status: 'sending', skipped: 'no_tier_headroom', headroom: 0, sent: 0, failed: 0 }

  // INTEG-C3 — per-location prepaid wallet gate (composes with the
  // per-broadcast daily_cap and Meta tier budget above — all apply):
  // allowance exhausted + wallet empty parks THIS tick; the drip stays
  // 'sending' and a later tick re-checks, so a top-up resumes it with
  // no operator action (the no_headroom posture). Unpinned locations
  // answer 'unpinned' → byte-identical old behaviour. Fail-open.
  try {
    const spend = await checkSpend(db, broadcast.location_id, 'wa_template_send', 'marketing')
    if (!spend.allow) return { status: 'sending', skipped: 'wallet_empty', sent: 0, failed: 0 }
  } catch { /* fail open */ }

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
  // FREQ-CAP.1 — cross-channel marketing frequency cap: contacts touched by
  // ANY marketing channel inside the operator's window are held out of THIS
  // tick via the selection predicate (no recipient row written — they're not
  // in doneIds, so a later tick re-picks them once the window clears, and
  // `deferred` > 0 blocks exhaustion so the drip stays open until then).
  // Runs after the consent/reachability audience gate by construction.
  // See selectDripRecipients for why this beats the 131049 'capped' park.
  const capSetting = await getLocationFrequencyCap(db, broadcast.location_id)
  // Per-drip burstiness override (mig 328) — falls back to the code default.
  const { toSend, exhausted, deferred } = selectDripRecipients({
    audience,
    doneIds,
    headroom,
    perTickMax: broadcast.per_tick_max || perTickMax,
    isEligible: (c) => !isFrequencyCapped(c, capSetting),
  })

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
    // FREQ-CAP.1 — everyone still owed a send is inside their cap window:
    // hold the drip open and let a later tick re-pick them.
    if (deferred > 0) {
      return { status: 'sending', skipped: 'awaiting_frequency_cap', deferred, sent: 0, failed: 0 }
    }
    return { status: 'sending', skipped: 'no_capacity', sent: 0, failed: 0 }
  }

  const branding = await getLocationBranding(db, broadcast.location_id)
  const variableMapping = broadcast.variable_mapping || {}
  // AGENT-TAKEOVER — pause Mia on each recipient thread for an individual send
  // (audience of 1) or an opt-in bulk drip the operator is handling.
  const pauseAgent = shouldPauseAgentForBroadcast(broadcast, audience.length)
  let sent = 0, failed = 0, capped = 0, consecutiveFailures = 0, autoPaused = false
  // FREQ-CAP.1 — batch marketing-touch stamp after the loop (always stamped,
  // even while the cap is disabled, so enabling it later has history).
  const dripSentContactIds = []

  for (const contact of toSend) {
    // CLAIM-FIRST, and now genuinely the same mutex the blast sender uses —
    // see claimDripRecipient. The recipients row is the ONLY dedupe this drip
    // has (fetchDripDoneContactIds excludes every contact that already has
    // one), and it used to be written AFTER the template went out with a bare
    // `await` whose error nothing could see, so a lost row re-selected the
    // contact next tick and sent the same marketing template again. Claiming
    // first makes a DB hiccup cost at most a missing message, never a duplicate
    // one; a row stuck at 'pending' is the accepted outcome the blast has too.
    const claim = await claimDripRecipient(db, broadcastId, contact.id)
    if (!claim.claimed) {
      if (claim.reason !== 'already_claimed') {
        console.error(`[drip ${broadcastId}] could not claim recipient ${contact.id} — skipping rather than sending unrecorded:`, claim.reason)
      }
      continue
    }
    try {
      const components = buildTemplateComponents(template, contact, variableMapping, broadcast.header_media_url, { companyName: branding.companyName, locationId: broadcast.location_id })
      const result = await sendTemplateMessage(contact.wa_phone, template.name, template.language, components, { config })

      // Promote the claimed row. Upsert (not update): the claim above may have
      // raced, and a contact retried after a 'capped' park already has a row.
      const { error: promoteErr } = await db.from('whatsapp_broadcast_recipients').upsert({
        broadcast_id: broadcastId, contact_id: contact.id,
        wa_message_id: result.messageId, status: 'sent', sent_at: new Date().toISOString(),
      }, { onConflict: 'broadcast_id,contact_id' })
      if (promoteErr) console.error(`[drip ${broadcastId}] sent to ${contact.id} but the recipient row stayed 'pending' (counts will under-report; no re-send):`, promoteErr.message)
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
      dripSentContactIds.push(contact.id)
    } catch (err) {
      // Meta's cross-business per-user marketing frequency cap (131049) is a
      // SOFT failure: the user is temporarily saturated, not unreachable. Park
      // the row as 'capped' — fetchDripDoneContactIds re-opens it after
      // CAPPED_RETRY_HOURS so the next day's tick retries — and never let it
      // mark the number undeliverable or trip the auto-pause.
      if (isFrequencyCapError({ message: err.message })) {
        console.warn(`[drip ${broadcastId}] frequency-capped ${contact.wa_phone} — retrying next day`)
        // A lost park leaves the claim at 'pending', which reads as done — the
        // contact is never retried. That is the safe direction (no duplicate),
        // but it is a real loss, so say it.
        const { error: parkErr } = await db.from('whatsapp_broadcast_recipients').upsert({
          broadcast_id: broadcastId, contact_id: contact.id,
          status: 'capped', error_message: err.message, failed_at: new Date().toISOString(),
        }, { onConflict: 'broadcast_id,contact_id' })
        if (parkErr) console.error(`[drip ${broadcastId}] could not park ${contact.id} as 'capped' — it stays 'pending' and will NOT be retried:`, parkErr.message)
        capped++
        continue
      }
      console.error(`[drip ${broadcastId}] send to ${contact.wa_phone} failed:`, err.message)
      const { error: parkErr } = await db.from('whatsapp_broadcast_recipients').upsert({
        broadcast_id: broadcastId, contact_id: contact.id,
        status: 'failed', error_message: err.message, failed_at: new Date().toISOString(),
      }, { onConflict: 'broadcast_id,contact_id' })
      if (parkErr) console.error(`[drip ${broadcastId}] could not park ${contact.id} as 'failed' — it stays 'pending':`, parkErr.message)
      // Permanently-undeliverable number → flag so future audiences skip it.
      await markUndeliverableIfPermanent(db, contact.id, { message: err.message })
      failed++; consecutiveFailures++
      if (consecutiveFailures >= AUTO_PAUSE_CONSECUTIVE_FAILURES) { autoPaused = true; break }
    }
    // Same conservative rate-limit as the blast sender (~50/sec ceiling).
    if (sent % 50 === 0 && sent > 0) await new Promise(r => setTimeout(r, 1000))
  }

  // FREQ-CAP.1 — marketing-touch stamp for this tick's successful sends.
  await stampMarketingTouch(db, dripSentContactIds)

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

  // Dynamic URL buttons: the approved template's link ends in a variable, so
  // every send must carry its value or Meta rejects the message (132012). The
  // value comes from the reserved mapping key and resolves like a body variable
  // — a contact field, or a literal (a campaign code) via the literal fallback.
  // Sends with nothing mapped are refused upstream by urlButtonSendBlock(); the
  // omission here is the belt to that braces.
  const urlIdx = dynamicUrlButtonIndex(templateComponents)
  if (urlIdx >= 0) {
    const mapped = (variableMapping || {})[URL_BUTTON_MAPPING_KEY]
    const value = String(mapped ?? '').trim() ? resolveContactField(mapped, contact, opts) : ''
    if (value) {
      components.push({ type: 'button', sub_type: 'url', index: String(urlIdx), parameters: [{ type: 'text', text: value }] })
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
 * Pick the contact an inbound message should link to when the sender's
 * phone matches several contact rows. Pure — used by the WhatsApp
 * webhook (COMMS-AUDIT 2026-07-10).
 *
 * Policy: prefer a contact in the RECEIVING number's location (each
 * WhatsApp number belongs to one location; a member of that gym texting
 * its number must land on their record there, not on a same-phone
 * contact at another location). Only when no in-location match exists
 * fall back to a cross-location match — the caller passes the list
 * deterministically ordered (oldest contact first) so the fallback is
 * stable rather than Postgres row order.
 *
 * @param {Array<{id: string, location_id: string}>|null} matches
 * @param {string|null} preferredLocationId  the receiving number's location
 * @returns {object|null}
 */
export function pickInboundContact(matches, preferredLocationId) {
  if (!Array.isArray(matches) || matches.length === 0) return null
  if (preferredLocationId) {
    const inLocation = matches.find((m) => m?.location_id === preferredLocationId)
    if (inLocation) return inLocation
  }
  return matches[0]
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
  // SINGLEERR.1 — the wa_phone branch above already reads `error`; this
  // fallback discarded it, so a rejected insert returned undefined and the
  // caller reported "no conversation" with no reason.
  const { data: created, error: createErr } = await db.from('whatsapp_conversations').insert({
    location_id: locationId,
    contact_id: contact.id,
    wa_phone: null,
    status: 'active',
  }).select('id').single()
  if (createErr) {
    console.error('[whatsapp] conversation insert (no wa_phone) failed:', createErr.message)
  }
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
