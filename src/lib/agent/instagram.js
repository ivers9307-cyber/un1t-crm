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
import { ensureInstagramMediaRehosted } from '@/lib/instagram-media-server'
import { resolveContactForInstagramThread } from '@/lib/instagram-contact-link-server'
import { splitMessageText, INSTAGRAM_TEXT_LIMIT } from '@/lib/message-split'
import { mediaRenderKind } from '@shared/whatsapp-media'

// IG-MEDIA.1 — map an inbound IG attachment type to the message_type we
// store. Chosen so the shared mediaRenderKind() (also used by WhatsApp)
// resolves the right inline renderer. IG "file" → "document" because
// mediaRenderKind classifies documents by MIME (image/pdf/etc).
// story_mention deliberately keeps its raw type: mediaRenderKind resolves it
// by MIME (a story frame is a photo or a clip) and never returns null for it,
// so it still passes every media gate (IG-MEDIA.2). Types genuinely without a
// renderer (share, reel…) keep their raw type and show a text placeholder.
const IG_ATTACHMENT_TYPE_TO_MESSAGE_TYPE = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  file: 'document',
}

// IG-LOWSIG.1 — attachment kinds that are ambient social signals rather than
// conversation: a story mention (someone tagged the gym in their story) or a
// post/reel shared into the DM thread. These arrive constantly and almost
// never need a human, so the inbound handler records them as thread history
// but does not escalate. share/reel/ig_reel cover the observed vocabulary for
// shared feed content across the two webhook flavors.
const LOW_SIGNAL_IG_TYPES = new Set(['story_mention', 'share', 'reel', 'ig_reel'])

/**
 * Is this inbound event ambient social noise (a story mention, a shared
 * post/reel, or an emoji-only story reaction) rather than a message that
 * needs a human? Pure. Any real words attached — a caption on a share, a
 * typed story reply — make it a genuine message again, because "saw your
 * post, is this class on tonight?" arrives exactly this way. Echoes are
 * never low-signal (they're our own outbound, handled elsewhere).
 */
export function isLowSignalInstagramEvent(event) {
  if (!event || event.isEcho) return false
  const text = (event.text || '').trim()
  // Letters or digits in any script = the customer typed something.
  const hasWords = /[\p{L}\p{N}]/u.test(text)
  if (LOW_SIGNAL_IG_TYPES.has(event.type)) return !hasWords
  // A quick-reaction to a story lands as a story reply whose text is just the
  // emoji. An emoji-only message OUTSIDE a story reply stays escalated — a
  // bare "👍" mid-conversation can be a real answer to a real question.
  if (event.isStoryReply && text && !hasWords) return true
  return false
}


/**
 * Normalise a Meta Instagram webhook body into a flat list of message
 * events. Pure — no IO. Emits echoes too (`isEcho: true` — a message WE
 * sent, from the CRM or the native IG app), which the handler records so
 * a staff app-reply marks the thread answered. Skips reactions, read
 * receipts, and events with no `message`.
 *
 * @param {object} body  the parsed webhook JSON
 * @returns {Array<{accountId:string, customerId:string, messageId:string|null, text:string, type:string, mediaUrl:string|null, timestamp:number|null, isEcho:boolean, isStoryReply:boolean}>}
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
      // IG delivers media inline as a direct CDN URL in the FIRST attachment's
      // payload (one media per message, mirroring how we store WA media). Map
      // the IG attachment type to the message_type we persist, chosen so the
      // shared mediaRenderKind() resolves the right inline renderer. Types with
      // no inline renderer (share, story_mention, reel…) keep their raw type
      // and fall back to a text placeholder. (IG-MEDIA.1)
      const attachment = Array.isArray(msg.attachments) ? msg.attachments[0] : null
      const mediaUrl = attachment?.payload?.url || null
      const type = attachment
        ? (IG_ATTACHMENT_TYPE_TO_MESSAGE_TYPE[attachment.type] || attachment.type || 'attachment')
        : 'text'
      out.push({
        accountId,
        customerId,
        messageId: msg.mid || null,
        text,
        type,
        mediaUrl,
        timestamp: ev.timestamp || null,
        isEcho,
        // A reply to (or quick-reaction on) one of our stories carries the
        // story under message.reply_to — the signal isLowSignalInstagramEvent
        // needs to tell an emoji-only story reaction from a real emoji answer.
        isStoryReply: !!msg.reply_to?.story,
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
  // MIA-HYGIENE.6 — Instagram's DM cap is 1000 chars, far lower than
  // WhatsApp's, so this is the likelier of the two to be crossed by ordinary
  // copy. Split rather than let Meta reject the whole message.
  const parts = splitMessageText(text, INSTAGRAM_TEXT_LIMIT)
  let result = {}

  for (const part of parts) {
    const res = await fetch(`${IG_GRAPH_URL}/${encodeURIComponent(igId)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        recipient: { id: recipientIgsid },
        message: { text: part },
      }),
    })
    result = await res.json().catch(() => ({}))
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
  }
  // INTEG-A3 — a delivered send proves the connection works right now.
  if (conn?.id) await stampConnectionOk(null, conn.id)
  return { messageId: result.message_id || null }
}

/**
 * Tell Instagram the customer's messages have been read (IG-SEEN.1).
 *
 * Answering in the CRM did not clear the thread's unread state in the
 * Instagram app, because a reply through the API is not itself a read
 * receipt — Meta needs an explicit `mark_seen` sender action. Without it
 * staff see a thread they have already handled still sitting bold on the
 * phone.
 *
 * Best-effort by design: this is a courtesy signal, so a failure is logged
 * and swallowed. It must never fail a reply that actually went out.
 *
 * @param {string} recipientIgsid  the customer's IGSID
 * @param {object} opts { connection }  channel_connections row
 * @returns {Promise<boolean>} whether Meta accepted it
 */
export async function markInstagramSeen(recipientIgsid, opts = {}) {
  const conn = opts.connection
  const token = conn?.access_token
  if (!token || !recipientIgsid) return false
  try {
    const igId = conn?.external_account_id || 'me'
    const res = await fetch(`${IG_GRAPH_URL}/${encodeURIComponent(igId)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        recipient: { id: recipientIgsid },
        sender_action: 'mark_seen',
      }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      console.error('[instagram mark_seen] rejected', body?.error?.message || `HTTP ${res.status}`)
      return false
    }
    return true
  } catch (e) {
    console.error('[instagram mark_seen] failed', e?.message)
    return false
  }
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
    .select('id, contact_id, agent_handed_off_at, customer_name, ig_username')
    .eq('location_id', locationId)
    .eq('ig_user_id', event.customerId)
    .maybeSingle()

  let conversationId = existingConv?.id
  let contactId = existingConv?.contact_id || null
  const existingHandoffAt = existingConv?.agent_handed_off_at || null
  // Identity shown by Instagram, for contact matching below. Comes off the
  // stored row for a known thread, or the freshly-fetched profile for a new one.
  let igDisplayName = existingConv?.customer_name || null
  let igHandle = existingConv?.ig_username || null
  if (!conversationId) {
    // Capture the customer's IG display name once, so the agent can use
    // the surname as a verification factor without making them retype it.
    const profile = await fetchInstagramProfile(event.customerId, connection)
    igDisplayName = profile?.name || igDisplayName
    igHandle = profile?.username || igHandle
    const { data: created, error: createError } = await db.from('instagram_conversations').insert({
      location_id: locationId,
      channel_connection_id: connection?.id || null,
      ig_user_id: event.customerId,
      ig_username: profile?.username || null,
      customer_name: profile?.name || null,
      status: 'active',
    }).select('id').single()
    conversationId = created?.id
    if (!conversationId) {
      // Lost the first-message create race: two concurrent first-ever
      // messages from one IGSID both miss the lookup above and both insert,
      // and the loser trips the unique idx_ig_conv_location_user (mig 231).
      // Bailing here dropped the customer's first message PERMANENTLY — the
      // route records msg:<mid> in webhook_events before processing, so
      // Meta's retry is deduped. Re-read the winner's row and carry on.
      const { data: raced } = await db.from('instagram_conversations')
        .select('id')
        .eq('location_id', locationId)
        .eq('ig_user_id', event.customerId)
        .maybeSingle()
      conversationId = raced?.id || null
      if (!conversationId) {
        console.error('[instagram inbound] conversation create failed', createError?.message || 'unknown')
      }
    }
  }
  if (!conversationId) return { handled: false, reason: 'no_conversation' }

  // IG-LINK.1 — attach the thread to a CRM contact when we safely can, so the
  // message rows below carry contact_id and the inbox shows the member's
  // profile/history instead of a stranger. Instagram exposes no phone or
  // email, so this is (1) the IGSID remembered on a contact from a previous
  // link, else (2) a strictly-guarded exact unique full-name match. Ambiguous
  // cases stay unlinked for staff to resolve. Best-effort: never blocks the
  // message.
  // Skipped for echoes: an echo is our OWN outbound reflected back, and the
  // echo branch below either dedups it away or records it — either way it
  // learns nothing new about who the customer is, so paying for the lookup
  // on every CRM/Mia send would be pure waste on the webhook's critical path.
  if (!contactId && !event.isEcho) {
    contactId = await resolveContactForInstagramThread(db, {
      conversationId,
      locationId,
      igsid: event.customerId,
      displayName: igDisplayName,
      handle: igHandle,
    })
  }

  const ts = event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString()
  const messageType = event.type || 'text'
  const mediaUrl = event.mediaUrl || null
  // Stored body is: the caption for renderable media (image/video/audio, and
  // since IG-MEDIA.2 story mentions too — the media renders from its own
  // columns, so a placeholder would sit under the picture), a "[type]" label
  // for kinds with no renderer at all (shares, reels) so the bubble isn't
  // blank, and the text otherwise. previewText always yields a "[type]"
  // fallback for the conversation list + push when there's no caption.
  // (IG-MEDIA.1/.2)
  const body = event.text || (messageType !== 'text' && !mediaRenderKind(messageType) ? `[${messageType}]` : '')
  const previewText = (body || `[${messageType}]`).slice(0, 100)

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
    // IG-MEDIA.2 — media_url was missing here: the echo path predates
    // IG-MEDIA.1, which only wired the inbound insert below. Anything sent
    // from the native IG app (a photo, or a story mention echoed back when
    // the business tags someone) recorded as a bare placeholder with the
    // image silently dropped, and the IG CDN URL expires within about a day,
    // so it was unrecoverable after the fact.
    const { data: insertedEcho, error: echoErr } = await db.from('instagram_messages').insert({
      conversation_id: conversationId,
      contact_id: contactId,
      location_id: locationId,
      ig_message_id: event.messageId,
      direction: 'outbound',
      message_type: messageType,
      body,
      media_url: mediaUrl,
      status: 'sent',
      source: 'instagram_app',
      sent_at: ts,
    }).select('id').single()
    if (echoErr) {
      // 23505 on the unique idx_ig_msg_mid = our own CRM/agent send landed
      // between the dedup lookup above and this insert (webhook/send race).
      // It's NOT an external reply, so do NOT run the takeover below — that
      // would flip agent_active off on Mia's own message. Just bail.
      if (echoErr.code === '23505') return { handled: false, reason: 'echo_own_send', conversationId }
      console.error('[instagram echo] insert failed', echoErr.message)
      return { handled: false, reason: 'echo_insert_failed', conversationId }
    }
    // Re-host while the CDN URL is fresh, same as the inbound path.
    if (mediaUrl && insertedEcho?.id && mediaRenderKind(messageType)) {
      try {
        await ensureInstagramMediaRehosted(db, {
          id: insertedEcho.id,
          location_id: locationId,
          message_type: messageType,
          media_url: mediaUrl,
          media_storage_path: null,
        }, { token: connection?.access_token })
      } catch (e) {
        console.error('[instagram echo] media rehost failed (will lazy-load):', e?.message)
      }
    }

    // A human replied from outside the CRM → mirror the operator send
    // route exactly: take over (stop Mia) and flip the thread to
    // answered, so app-replies and CRM-replies behave identically in the
    // inbox queues. No agent trigger, no push (this is our own outbound).
    await db.from('instagram_conversations').update({
      last_message_at: ts,
      last_message_direction: 'outbound',
      last_message_preview: previewText,
      agent_active: false,
      agent_handed_off_at: existingHandoffAt || ts,
      updated_at: ts,
    }).eq('id', conversationId)
    return { handled: true, conversationId, echo: true }
  }

  const { data: insertedInbound, error: inboundInsertError } = await db.from('instagram_messages').insert({
    conversation_id: conversationId,
    contact_id: contactId,
    location_id: locationId,
    ig_message_id: event.messageId,
    direction: 'inbound',
    message_type: messageType,
    body,
    media_url: mediaUrl,
    status: 'delivered',
    sent_at: ts,
  }).select('id').single()
  // supabase-js returns { error } without throwing — an unchecked rejected
  // insert (the 2026-06-12 amnesia class) left the agent answering history
  // that was MISSING the triggering message. Log it and skip the agent turn
  // below; the conversation bump and the staff push still run so a human
  // picks the thread up, and the handler still returns normally (the route
  // must answer 200 or Meta disables the hook).
  if (inboundInsertError) {
    console.error('[instagram inbound] message insert failed (agent turn skipped):', inboundInsertError.message)
  }

  // IG-MEDIA.1 — re-host inbound media into the private whatsapp-media
  // bucket now, while the IG CDN URL is still fresh (it expires fast), so
  // the inbox shows it without a first-view round-trip. Best-effort and
  // bounded: never block or fail the webhook — /api/instagram/media
  // re-hosts lazily if this misses. Gated to renderable kinds — which now
  // includes story mentions, since mediaRenderKind never returns null for
  // them (IG-MEDIA.2). Kinds with no renderer at all (shares, reels) still
  // carry a url but are deliberately left alone.
  if (mediaUrl && insertedInbound?.id && mediaRenderKind(messageType)) {
    try {
      await ensureInstagramMediaRehosted(db, {
        id: insertedInbound.id,
        location_id: locationId,
        message_type: messageType,
        media_url: mediaUrl,
        media_storage_path: null,
      }, { token: connection?.access_token })
    } catch (e) {
      console.error('[instagram inbound] media rehost failed (will lazy-load):', e?.message)
    }
  }

  // INTEG-A3 — a delivered inbound proves the connection is alive.
  // Best-effort; never blocks the inbound path.
  await stampConnectionOk(db, connection?.id)

  // IG-LOWSIG.1 — story mentions, shared posts/reels and emoji-only story
  // reactions are recorded (above) but never escalated: no auto-unresolve, no
  // needs-reply flip, no unread bump, no agent turn, no staff push. Opening
  // the thread still shows them; they just don't demand anyone's attention.
  const lowSignal = isLowSignalInstagramEvent(event)

  // Bump conversation summary + unread. A low-signal event bumps only the
  // timestamp + preview (so the thread list stays truthful) — leaving
  // resolved_at and last_message_direction alone keeps an answered thread
  // answered and out of the needs-action queues (src/lib/inbox-queues.js).
  await db.from('instagram_conversations').update(lowSignal
    ? {
        last_message_at: ts,
        last_message_preview: previewText,
      }
    : {
        last_message_at: ts,
        last_message_direction: 'inbound',
        resolved_at: null,
        last_message_preview: previewText,
      }).eq('id', conversationId)
  // Atomic unread bump (best-effort) — replaces the read-modify-write above.
  if (!lowSignal) {
    try { await db.rpc('increment_instagram_conversation_unread', { p_conversation_id: conversationId }) } catch {}
  }

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
  if (isAgentEnabledForConnection(connection) && !inboundInsertError && !lowSignal) {
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
  if (!agentEngaged && !lowSignal) {
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

  return { handled: true, conversationId, lowSignal }
}
