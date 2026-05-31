// RADAR-AGENT — customer-agent auto-reply orchestrator (IO).
//
// Channel-agnostic. The shared brain (settings gate, knowledge,
// history, the Anthropic call, parse, handoff) lives in
// runChannelAgent(); a per-channel ADAPTER supplies the table names,
// the send function, the row shapes, and the notification labels. The
// pure decisions/formatting are in core.js / prompt.js.
//
// Channels today:
//   - WhatsApp: maybeAutoReply(), called from the WhatsApp webhook.
//   - Instagram: handleInstagramInbound() in instagram.js calls
//     runChannelAgent() directly with the instagramAdapter.
// Both reuse the exact same runner — only the adapter differs.
//
// Safety posture: gated OFF by default (locations.settings
// .customer_agent) + test-mode allow-list; no tools / no account
// actions (answers from knowledge or hands off); never throws.

import { sendTextMessage } from '@/lib/whatsapp'
import { sendPushToRolesAtLocation } from '@/lib/push'
import { MANAGER_ROLES } from '@/lib/schemas'
import { buildCustomerSystemPrompt } from './prompt'
import {
  shouldAgentReply,
  formatHistoryForClaude,
  parseAgentResponse,
  AGENT_MESSAGE_SOURCE,
  DEFAULT_HOLDING_MESSAGE,
} from './core'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const AGENT_MODEL = 'claude-sonnet-4-20250514'
const MAX_HISTORY = 20

/**
 * Generic per-channel agent turn.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {object} adapter  channel adapter (see whatsappAdapter / instagramAdapter)
 * @param {object} ctx
 */
export async function runChannelAgent(db, adapter, ctx) {
  const { conversationId, locationId, recipient, contactId, messageType, body, connection } = ctx

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return { handled: false, reason: 'no_api_key' }
  if (!conversationId || !locationId) return { handled: false, reason: 'missing_context' }

  const { data: loc } = await db.from('locations')
    .select('name, settings')
    .eq('id', locationId)
    .single()
  const settings = loc?.settings?.customer_agent || null

  // Per-conversation kill switch (human takeover / prior escalation).
  const { data: conv } = await db.from(adapter.conversationsTable)
    .select('agent_active')
    .eq('id', conversationId)
    .single()

  const decision = shouldAgentReply({
    settings,
    conversation: conv,
    message: { type: messageType, body },
    senderPhone: recipient,
    now: new Date(),
  })
  if (!decision.reply) return { handled: false, reason: decision.reason }

  const { data: knowledge } = await db.from('agent_knowledge')
    .select('category, title, content, enabled, sort_order')
    .eq('location_id', locationId)
    .eq('enabled', true)
    .order('sort_order', { ascending: true })

  const { data: history } = await db.from(adapter.messagesTable)
    .select('direction, body, message_type, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(MAX_HISTORY * 2)

  const systemPrompt = buildCustomerSystemPrompt({
    businessName: 'UN1T',
    locationName: loc?.name || null,
    tone: settings?.tone || null,
    extraRules: settings?.extra_rules || null,
    knowledge: knowledge || [],
    today: new Date().toISOString().slice(0, 10),
  })

  const messages = formatHistoryForClaude(history || [], { maxMessages: MAX_HISTORY })
  if (messages.length === 0) return { handled: false, reason: 'no_history' }

  let modelText = ''
  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: AGENT_MODEL,
        max_tokens: 600,
        system: systemPrompt,
        messages,
      }),
    })
    if (!res.ok) {
      console.error('[radar-agent] Anthropic error', res.status, await res.text().catch(() => ''))
      return { handled: false, reason: 'model_error' }
    }
    const data = await res.json()
    modelText = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n')
  } catch (err) {
    console.error('[radar-agent] model call failed', err?.message)
    return { handled: false, reason: 'model_exception' }
  }

  const parsed = parseAgentResponse(modelText)
  const common = { conversationId, locationId, recipient, contactId, connection }

  if (parsed.action === 'handoff') {
    await handoff(db, adapter, { ...common, reason: parsed.reason, settings })
    return { handled: true, action: 'handoff', reason: parsed.reason }
  }

  await sendAndLog(db, adapter, { ...common, text: parsed.text })
  return { handled: true, action: 'reply' }
}

// Send an agent reply + persist it + update the conversation.
async function sendAndLog(db, adapter, { conversationId, locationId, recipient, contactId, connection, text }) {
  let messageId = null
  try {
    const r = await adapter.send(recipient, text, { locationId, connection })
    messageId = r?.messageId || null
  } catch (err) {
    console.error(`[radar-agent] ${adapter.name} send failed`, err?.message)
    return
  }

  const now = new Date().toISOString()
  await db.from(adapter.messagesTable).insert(
    adapter.outboundRow({ conversationId, locationId, contactId, messageId, text, now })
  )
  await db.from(adapter.conversationsTable).update({
    last_message_at: now,
    last_message_direction: 'outbound',
    last_message_preview: text.substring(0, 100),
    agent_last_reply_at: now,
  }).eq('id', conversationId)
}

// Escalate: holding message, stop the agent on this thread, notify staff.
async function handoff(db, adapter, { conversationId, locationId, recipient, contactId, connection, reason, settings }) {
  const holding = (settings?.holding_message || '').trim() || DEFAULT_HOLDING_MESSAGE
  const now = new Date().toISOString()

  await db.from(adapter.conversationsTable).update({
    agent_active: false,
    agent_handed_off_at: now,
  }).eq('id', conversationId)

  try {
    const r = await adapter.send(recipient, holding, { locationId, connection })
    await db.from(adapter.messagesTable).insert(
      adapter.outboundRow({ conversationId, locationId, contactId, messageId: r?.messageId || null, text: holding, now })
    )
    await db.from(adapter.conversationsTable).update({
      last_message_at: now,
      last_message_direction: 'outbound',
      last_message_preview: holding.substring(0, 100),
    }).eq('id', conversationId)
  } catch (err) {
    console.error(`[radar-agent] ${adapter.name} holding-message send failed`, err?.message)
  }

  try {
    await sendPushToRolesAtLocation(locationId, MANAGER_ROLES, {
      title: `${adapter.label} · needs a human`,
      body: `Agent handed off: ${reason || 'see conversation'}`,
      category: adapter.pushCategory,
      data: { type: adapter.handoffType, conversation_id: conversationId },
    })
  } catch (err) {
    console.error(`[radar-agent] ${adapter.name} handoff push failed`, err?.message)
  }
}

// ── WhatsApp adapter ────────────────────────────────────────────────
export const whatsappAdapter = {
  name: 'whatsapp',
  label: 'WhatsApp',
  conversationsTable: 'whatsapp_conversations',
  messagesTable: 'whatsapp_messages',
  pushCategory: 'whatsapp',
  handoffType: 'whatsapp_agent_handoff',
  send: (recipient, text, { locationId }) => sendTextMessage(recipient, text, { locationId }),
  outboundRow: ({ conversationId, locationId, contactId, messageId, text, now }) => ({
    conversation_id: conversationId,
    contact_id: contactId || null,
    location_id: locationId,
    wa_message_id: messageId,
    direction: 'outbound',
    message_type: 'text',
    body: text,
    status: 'sent',
    source: AGENT_MESSAGE_SOURCE,
    sent_at: now,
  }),
}

/**
 * WhatsApp entry point — unchanged signature, called from the WA webhook.
 * Delegates to the shared runner via the WhatsApp adapter.
 */
export async function maybeAutoReply(db, ctx) {
  return runChannelAgent(db, whatsappAdapter, {
    conversationId: ctx.conversationId,
    locationId: ctx.locationId,
    recipient: ctx.senderPhone,
    contactId: ctx.contactId,
    messageType: ctx.messageType,
    body: ctx.body,
  })
}
