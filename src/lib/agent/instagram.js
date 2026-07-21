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

import { resolveLocationByExternalAccount, isAgentEnabledForConnection, IG_GRAPH_URL } from './channels'
import { runChannelAgent } from './auto-reply'
import { AGENT_MESSAGE_SOURCE } from './core'
import { sendPush, sendPushToRolesAtLocation } from '@/lib/push'
import { MANAGER_ROLES } from '@/lib/schemas'
import { stampConnectionOk, stampConnectionError, isMetaAuthError } from '@/lib/connection-health'

/**
 * Normalise a Meta Instagram webhook body into a flat list of message
 * events. Pure — no IO. Emits echoes too (`isEcho: true` — a message WE
 * sent, from the CRM or the native IG app), which the handler records so
 * a staff app-reply marks the thread answered. Skips reactions, read
 * receipts, and events with no `message`.
 *
 * @param {object} body  the parsed webhook JSON
 * @returns {Array<{accountId:string, customerId:string, messageId:string|null, text:string, type:string, timestamp:number|null, isEcho:boolean}>}
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
      // Direction-aware normalisation. `entry.id` is ALWAYS our own IG
      // business account (the webhook owner) in both directions — the
      // stable anchor for resolving the location. The customer is the
      // OTHER party: for inbound it's the sender, for an echo (a message
      // WE sent, from the CRM or the native IG app) it's the recipient.
      // Confirmed against real captured payloads (IG-ECHO diagnostic).
      const accountId = entry.id || (isEcho ? ev.sender?.id : ev.recipient?.id) || null
      const customerId = (isEcho ? ev.recipient?.id : ev.sender?.id) || null
      const text = typeof msg.text === 'string' ? msg.text : ''
      const hasAttachments = Array.isArray(msg.attachments) && msg.attachments.length > 0
      out.push({
        accountId,
        customerId,
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
 * Send an Instagram DM via the Instagram Login API (graph.instagram.com)
 * using the connection's Instagram User token. The explicit account id in
 * the path (not /me/) avoids any ambiguity about what the token resolves
 * to; token travels in the Authorization header, never the URL.
 * @param {string} recipientIgsid  the customer's IGSID
 * @param {string} text
 * @param {object} opts { connection }  channel_connections row (access_token, external_account_id)
 */
export async function sendInstagramMessage(recipientIgsid, text, opts = {}) {
  const conn = opts.connection
  const token = conn?.access_token
  if (!token) throw new Error('No Instagram access token for this location')

  const igId = conn?.external_account_id || 'me'
  const res = await fetch(`${IG_GRAPH_URL}/${encodeURIComponent(igId)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      recipient: { id: recipientIgsid },
      message: { text },
    }),
  })
  const result = await res.json().catch(() => ({}))
  if (!res.ok || result.error) {
    const msg = result?.error?.message || `Instagram send failed (${res.status})`
    console.error('[radar-agent] IG send error', msg)
    // INTEG-A3 — an auth-shaped failure means the stored token is bad:
    // surface it on the connection row. Transient failures don't stamp.
    // Best-effort (the helper swallows its own errors); needs a full
    // connection row (id) — synthetic { access_token } callers just skip.
    if (conn?.id && isMetaAuthError(result?.error, res.status)) {
      await stampConnectionError(null, conn.id, msg)
    }
    throw new Error(msg)
  }
  // INTEG-A3 — a delivered send proves the connection works right now.
  if (conn?.id) await stampConnectionOk(null, conn.id)
  return { messageId: result.message_id || null }
}

/**
 * Best-effort fetch of a customer's IG display name + handle via the
 * Instagram Login API, using the connection's Instagram User token
 * (messaging user-profile lookup — the IGSID must have messaged the
 * account). Captured once when a
 * conversation is created so the agent can use the surname (if shown) as
 * the second identity factor on the email-verification path. Returns null
 * on any failure — verification just falls back to asking for the surname.
 */
export async function fetchInstagramProfile(igsid, connection) {
  const token = connection?.access_token
  if (!token || !igsid) return null
  try {
    const res = await fetch(
      `${IG_GRAPH_URL}/${encodeURIComponent(igsid)}?fields=name,username`,
      { headers: { Authorization: `Bearer ${token}` } }
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
  // AGENT-REARM.2 — IG has no sequence/automation traffic, so any non-agent
  // outbound is an operator send.
  humanOutboundColumns: 'source',
  isHumanOutbound: (m) => m.source !== 'agent',
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
  if (!event) return { handled: false, reason: 'malformed' }
  if (!event.accountId || !event.customerId) return { handled: false, reason: 'malformed' }

  // Resolve which studio owns the IG business account this belongs to.
  // accountId is our own account in BOTH directions (inbound + echo).
  const resolved = await resolveLocationByExternalAccount('instagram', event.accountId, db)
  if (!resolved) return { handled: false, reason: 'unmatched_account' }
  const { locationId, connection } = resolved

  // Find-or-create the conversation (one per location + customer IGSID).
  const { data: existingConv } = await db.from('instagram_conversations')
    .select('id, contact_id, agent_handed_off_at')
    .eq('location_id', locationId)
    .eq('ig_user_id', event.customerId)
    .maybeSingle()

  let conversationId = existingConv?.id
  const contactId = existingConv?.contact_id || null
  const existingHandoffAt = existingConv?.agent_handed_off_at || null
  if (!conversationId) {
    // Capture the customer's IG display name once, so the agent can use
    // the surname as a verification factor without making them retype it.
    const profile = await fetchInstagramProfile(event.customerId, connection)
    const { data: created } = await db.from('instagram_conversations').insert({
      location_id: locationId,
      channel_connection_id: connection?.id || null,
      ig_user_id: event.customerId,
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

  // ── Echo path: a message WE sent, reflected back by Meta ────────────
  // Two sources: our own CRM/agent send (already persisted — dedup and
  // skip), or a reply a staff member typed from the native IG app /
  // Business Suite (record it, so the thread shows answered and Mia
  // steps aside). The echo mid equals the Send API's returned message_id
  // (verified), so an existing row with this ig_message_id means it was
  // our CRM/agent send.
  if (event.isEcho) {
    if (event.messageId) {
      const { data: already } = await db.from('instagram_messages')
        .select('id').eq('ig_message_id', event.messageId).limit(1).maybeSingle()
      if (already) return { handled: false, reason: 'echo_own_send', conversationId }
    }
    const { error: echoErr } = await db.from('instagram_messages').insert({
      conversation_id: conversationId,
      contact_id: contactId,
      location_id: locationId,
      ig_message_id: event.messageId,
      direction: 'outbound',
      message_type: messageType,
      body,
      status: 'sent',
      source: 'instagram_app',
      sent_at: ts,
    })
    if (echoErr) {
      // 23505 on the unique idx_ig_msg_mid = our own CRM/agent send landed
      // between the dedup lookup above and this insert (webhook/send race).
      // It's NOT an external reply, so do NOT run the takeover below — that
      // would flip agent_active off on Mia's own message. Just bail.
      if (echoErr.code === '23505') return { handled: false, reason: 'echo_own_send', conversationId }
      console.error('[instagram echo] insert failed', echoErr.message)
      return { handled: false, reason: 'echo_insert_failed', conversationId }
    }
    // A human replied from outside the CRM → mirror the operator send
    // route exactly: take over (stop Mia) and flip the thread to
    // answered, so app-replies and CRM-replies behave identically in the
    // inbox queues. No agent trigger, no push (this is our own outbound).
    await db.from('instagram_conversations').update({
      last_message_at: ts,
      last_message_direction: 'outbound',
      last_message_preview: body.substring(0, 100),
      agent_active: false,
      agent_handed_off_at: existingHandoffAt || ts,
      updated_at: ts,
    }).eq('id', conversationId)
    return { handled: true, conversationId, echo: true }
  }

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

  // INTEG-A3 — a delivered inbound proves the connection is alive.
  // Best-effort; never blocks the inbound path.
  await stampConnectionOk(db, connection?.id)

  // Bump conversation summary + unread.
  await db.from('instagram_conversations').update({
    last_message_at: ts,
    last_message_direction: 'inbound',
    resolved_at: null,
    last_message_preview: body.substring(0, 100),
  }).eq('id', conversationId)
  // Atomic unread bump (best-effort) — replaces the read-modify-write above.
  try { await db.rpc('increment_instagram_conversation_unread', { p_conversation_id: conversationId }) } catch {}

  // Trigger the agent (shared brain) FIRST so we know whether it engaged this
  // message before deciding the inbound push. Best-effort. IG-DM.3 — gated
  // per-connection: Mia only auto-replies on channels an operator has
  // explicitly opted in (agent_enabled, mig 407). Persistence and the
  // unread bump already ran above, and the push fan-out below still
  // fires when gated off (a null agentResult reads as not-engaged), so a
  // gated-off channel is a fully working staff-only inbox. The shared settings
  // blob can't express this: enabled/test_mode is per-location across
  // channels, and test_mode's allowlist is phone-based (IG senders have
  // IGSIDs), so the connection row is the right per-channel switch.
  let agentResult = null
  if (isAgentEnabledForConnection(connection)) {
    try {
      agentResult = await runChannelAgent(db, instagramAdapter, {
        conversationId,
        locationId,
        recipient: event.customerId,
        contactId,
        messageType,
        body,
        connection,
      })
    } catch (err) {
      console.error('[radar-agent] IG auto-reply failed', err?.message)
    }
  }

  // Push notification fan-out for inbound Instagram (MOBILE-MSG.M2) —
  // mirrors the WhatsApp webhook: assigned user first, otherwise
  // owners + managers + head coaches at the location. Per-user opt-in
  // is gated by permissions.mobile.notify_instagram inside sendPush().
  // Best-effort — never throw out of the inbound handler.
  // AGENT-ACTIVITY.1 — when the agent engaged (replied or handed off) it emits
  // its own debounced "chatting with Mia" ping to inbox staff, so SKIP this
  // generic per-message manager push to avoid double-notifying.
  const agentEngaged = agentResult?.handled === true &&
    ['reply', 'handoff', 'soft_handoff'].includes(agentResult.action)
  if (!agentEngaged) {
    try {
      const { data: convMeta } = await db.from('instagram_conversations')
        .select('assigned_to, customer_name, ig_username, contacts!contact_id(name, first_name)')
        .eq('id', conversationId)
        .single()
      const senderLabel = convMeta?.contacts?.name
        || convMeta?.contacts?.first_name
        || convMeta?.customer_name
        || (convMeta?.ig_username ? `@${convMeta.ig_username}` : null)
        || 'an Instagram user'
      const payload = {
        title: `Instagram · ${senderLabel}`,
        body: (body || '').substring(0, 140) || `[${messageType}]`,
        category: 'instagram',
        data: {
          type: 'instagram_inbound',
          conversation_id: conversationId,
        },
      }
      if (convMeta?.assigned_to) {
        await sendPush([convMeta.assigned_to], payload, { locationId })
      } else {
        await sendPushToRolesAtLocation(locationId, MANAGER_ROLES, payload)
      }
    } catch (err) {
      console.error('[instagram inbound] push failed', err?.message)
    }
  }

  return { handled: true, conversationId }
}
