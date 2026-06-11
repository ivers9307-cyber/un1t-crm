// RADAR-AGENT — Instagram DM send/receive for the customer agent.
//
// Mirrors the WhatsApp pieces but for Instagram messaging on the Meta
// Graph API. Per-location credentials come from channel_connections
// (mig 230); inbound DMs land in instagram_conversations /
// instagram_messages (mig 231). The agent brain is shared via the
// instagramAdapter passed to runChannelAgent.
//
// parseInstagramEvents() is pure (unit-tested). The rest is IO:
// handleInstagramInbound() persists the message + resolves the location
// by the IG business account id Meta posted to, then triggers the agent.

import { resolveLocationByExternalAccount, META_GRAPH_URL } from './channels'
import { runChannelAgent } from './auto-reply'
import { AGENT_MESSAGE_SOURCE } from './core'

/**
 * Normalise a Meta Instagram webhook body into a flat list of inbound
 * text events. Pure — no IO. Skips echoes (our own sends), reactions,
 * read receipts, and non-text payloads (which the agent hands off on).
 *
 * @param {object} body  the parsed webhook JSON
 * @returns {Array<{recipientAccountId:string, senderId:string, messageId:string|null, text:string, type:string, timestamp:number|null, isEcho:boolean}>}
 */
export function parseInstagramEvents(body) {
  const out = []
  if (!body || body.object !== 'instagram') return out
  for (const entry of (body.entry || [])) {
    const events = entry.messaging || []
    for (const ev of events) {
      const msg = ev.message
      if (!msg) continue                         // delivery/read/reaction → ignore
      const isEcho = !!msg.is_echo
      const senderId = ev.sender?.id || null
      const recipientAccountId = ev.recipient?.id || entry.id || null
      const text = typeof msg.text === 'string' ? msg.text : ''
      const hasAttachments = Array.isArray(msg.attachments) && msg.attachments.length > 0
      out.push({
        recipientAccountId,
        senderId,
        messageId: msg.mid || null,
        text,
        type: hasAttachments && !text ? 'attachment' : 'text',
        timestamp: ev.timestamp || null,
        isEcho,
      })
    }
  }
  return out
}

/**
 * Send an Instagram DM via the Graph API using a connection's page token.
 * @param {string} recipientIgsid  the customer's IGSID
 * @param {string} text
 * @param {object} opts { connection }  channel_connections row (access_token)
 */
export async function sendInstagramMessage(recipientIgsid, text, opts = {}) {
  const conn = opts.connection
  const token = conn?.access_token
  if (!token) throw new Error('No Instagram access token for this location')

  const res = await fetch(`${META_GRAPH_URL}/me/messages?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: recipientIgsid },
      message: { text },
    }),
  })
  const result = await res.json().catch(() => ({}))
  if (!res.ok || result.error) {
    const msg = result?.error?.message || `Instagram send failed (${res.status})`
    console.error('[radar-agent] IG send error', msg)
    throw new Error(msg)
  }
  return { messageId: result.message_id || null }
}

/**
 * Best-effort fetch of a customer's IG display name + handle via the
 * Graph API, using the location's page token. Captured once when a
 * conversation is created so the agent can use the surname (if shown) as
 * the second identity factor on the email-verification path. Returns null
 * on any failure — verification just falls back to asking for the surname.
 */
export async function fetchInstagramProfile(igsid, connection) {
  const token = connection?.access_token
  if (!token || !igsid) return null
  try {
    const res = await fetch(
      `${META_GRAPH_URL}/${encodeURIComponent(igsid)}?fields=name,username&access_token=${encodeURIComponent(token)}`
    )
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.error) return null
    return { name: data.name || null, username: data.username || null }
  } catch {
    return null
  }
}

// ── Instagram adapter for runChannelAgent ───────────────────────────
export const instagramAdapter = {
  name: 'instagram',
  label: 'Instagram',
  conversationsTable: 'instagram_conversations',
  messagesTable: 'instagram_messages',
  nameColumn: 'customer_name',
  pushCategory: 'instagram',
  handoffType: 'instagram_agent_handoff',
  send: (recipient, text, { connection }) => sendInstagramMessage(recipient, text, { connection }),
  outboundRow: ({ conversationId, locationId, contactId, messageId, text, now }) => ({
    conversation_id: conversationId,
    contact_id: contactId || null,
    location_id: locationId,
    ig_message_id: messageId,
    direction: 'outbound',
    message_type: 'text',
    body: text,
    status: 'sent',
    source: AGENT_MESSAGE_SOURCE,
    sent_at: now,
  }),
}

/**
 * Persist one inbound IG message + ensure the conversation, resolve the
 * owning location by the IG business account id, then trigger the agent.
 * Best-effort; never throws out of the webhook.
 *
 * @param {object} db   service-role client
 * @param {object} event  one element of parseInstagramEvents()
 */
export async function handleInstagramInbound(db, event) {
  if (!event || event.isEcho) return { handled: false, reason: 'echo' }
  if (!event.senderId || !event.recipientAccountId) return { handled: false, reason: 'malformed' }

  // Resolve which studio owns the IG business account that received this.
  const resolved = await resolveLocationByExternalAccount('instagram', event.recipientAccountId, db)
  if (!resolved) return { handled: false, reason: 'unmatched_account' }
  const { locationId, connection } = resolved

  // Find-or-create the conversation (one per location + customer IGSID).
  const { data: existingConv } = await db.from('instagram_conversations')
    .select('id, contact_id')
    .eq('location_id', locationId)
    .eq('ig_user_id', event.senderId)
    .maybeSingle()

  let conversationId = existingConv?.id
  const contactId = existingConv?.contact_id || null
  if (!conversationId) {
    // Capture the customer's IG display name once, so the agent can use
    // the surname as a verification factor without making them retype it.
    const profile = await fetchInstagramProfile(event.senderId, connection)
    const { data: created } = await db.from('instagram_conversations').insert({
      location_id: locationId,
      channel_connection_id: connection?.id || null,
      ig_user_id: event.senderId,
      ig_username: profile?.username || null,
      customer_name: profile?.name || null,
      status: 'active',
    }).select('id').single()
    conversationId = created?.id
  }
  if (!conversationId) return { handled: false, reason: 'no_conversation' }

  const ts = event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString()
  const messageType = event.type || 'text'
  const body = event.text || (messageType !== 'text' ? `[${messageType}]` : '')

  await db.from('instagram_messages').insert({
    conversation_id: conversationId,
    contact_id: contactId,
    location_id: locationId,
    ig_message_id: event.messageId,
    direction: 'inbound',
    message_type: messageType,
    body,
    status: 'delivered',
    sent_at: ts,
  })

  // Bump conversation summary + unread.
  const { data: convNow } = await db.from('instagram_conversations')
    .select('unread_count').eq('id', conversationId).single()
  await db.from('instagram_conversations').update({
    last_message_at: ts,
    last_message_direction: 'inbound',
    resolved_at: null,
    last_message_preview: body.substring(0, 100),
    unread_count: (convNow?.unread_count || 0) + 1,
  }).eq('id', conversationId)

  // Trigger the agent (shared brain). Best-effort.
  try {
    await runChannelAgent(db, instagramAdapter, {
      conversationId,
      locationId,
      recipient: event.senderId,
      contactId,
      messageType,
      body,
      connection,
    })
  } catch (err) {
    console.error('[radar-agent] IG auto-reply failed', err?.message)
  }

  return { handled: true, conversationId }
}
