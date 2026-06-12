// Instagram API helpers for mobile (MOBILE-MSG.M2).
//
// Unlike WhatsApp (whose tables grant authenticated SELECT, so mobile
// reads go direct to Supabase), the instagram_* tables deny direct
// authenticated access — every call here goes through the existing
// /api/instagram/* web routes via the api() helper, which carries the
// Bearer token + x-active-location + x-impersonate-target headers.
// Bonus: the thread GET resets unread_count server-side, so there's no
// separate mark-read call.

import { api } from './api'

export async function listConversations(locationId) {
  const qs = locationId ? `?location_id=${encodeURIComponent(locationId)}` : ''
  const res = await api(`/api/instagram/conversations${qs}`, { locationId })
  if (!res.success) return { success: false, error: res.error || 'Failed to load Instagram' }
  return { success: true, data: res.conversations || [] }
}

// Conversation + newest messages in one call. Resets unread server-side.
export async function getThread(conversationId, locationId) {
  const res = await api(`/api/instagram/conversations/${conversationId}`, { locationId })
  if (!res.success) return { success: false, error: res.error || 'Failed to load conversation' }
  return { success: true, conversation: res.conversation, messages: res.messages || [] }
}

// Operator manual reply. Server-side this is also a TAKE-OVER: the
// route sets agent_active=false so Mia stays quiet until the thread is
// resolved (which re-arms her — same loop as WhatsApp).
export function sendText(conversationId, text, locationId) {
  return api(`/api/instagram/conversations/${conversationId}/send`, {
    method: 'POST',
    locationId,
    body: { text },
  })
}

// Resolve (or un-resolve). Same PATCH semantics as WhatsApp — resolving
// a handed-off thread re-arms the agent server-side (AGENT-REARM.1).
export function resolveConversation(conversationId, resolved, locationId) {
  return api(`/api/instagram/conversations/${conversationId}`, {
    method: 'PATCH',
    locationId,
    body: { resolved: !!resolved },
  })
}

// Rate one of Mia's IG replies (AGENT-QA.1).
export function rateAgentMessage({ messageId, rating, note, locationId }) {
  return api('/api/agent/feedback', {
    method: 'POST',
    locationId,
    body: {
      channel: 'instagram',
      message_id: messageId,
      rating,
      note: note || null,
    },
  })
}

// Display-name precedence for an IG conversation row.
export function igDisplayName(conv) {
  const c = conv?.contacts
  return c?.name
    || c?.first_name
    || conv?.customer_name
    || (conv?.ig_username ? `@${conv.ig_username}` : null)
    || 'Instagram user'
}
