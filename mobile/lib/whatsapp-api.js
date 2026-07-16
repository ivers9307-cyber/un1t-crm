// WhatsApp API helpers for mobile.
//
// List reads happen direct against Supabase (RLS enforces per-location
// scoping). The thread itself (getThread) and everything that talks to
// Meta — send, template, block, react, card-set carousel, booking Flow
// — goes through the existing /api/whatsapp/* routes, which accept our
// mobile Bearer JWT (getCurrentUser) and own the 24-hour window check +
// Meta Graph API calls.

import { supabase } from './supabase'
import { api } from './api'

export async function listConversations(locationId) {
  let q = supabase.from('whatsapp_conversations')
    .select(`
      id, location_id, contact_id, wa_phone, wa_profile_name, status,
      last_message_at, last_message_direction, last_message_preview,
      unread_count, window_expires_at, assigned_to, created_at,
      resolved_at, agent_handed_off_at, agent_active, is_blocked,
      contacts:contact_id (id, name, first_name, last_name, pipeline_stage_slug)
    `)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(100)
  if (locationId) q = q.eq('location_id', locationId)
  const { data, error } = await q
  return error ? { success: false, error: error.message } : { success: true, data }
}

// Conversation + newest messages + Flow availability in one call, via
// the web GET route (mirrors the Instagram thread pattern). Resets
// unread_count server-side, so there's no separate mark-read call — and
// it's the only source of `flow_available` (locations.settings stays
// server-side; mobile never reads it directly). Messages come back
// newest-N-reversed already (the route fixed the ascending+limit
// oldest-rows freeze — see the conversation [id] route).
export async function getThread(conversationId, locationId) {
  const res = await api(`/api/whatsapp/conversations/${conversationId}`, { locationId })
  if (!res.success) return { success: false, error: res.error || 'Failed to load conversation' }
  return {
    success: true,
    conversation: res.conversation,
    messages: res.messages || [],
    flowAvailable: Boolean(res.flow_available),
  }
}

export function isWindowOpen(conversation) {
  if (!conversation?.window_expires_at) return false
  return new Date(conversation.window_expires_at) > new Date()
}

export function sendText(conversationId, text, locationId) {
  return api(`/api/whatsapp/conversations/${conversationId}/send`, {
    method: 'POST',
    locationId,
    body: { type: 'text', text },
  })
}

export function sendTemplate(conversationId, templateName, components, locationId) {
  return api(`/api/whatsapp/conversations/${conversationId}/send`, {
    method: 'POST',
    locationId,
    body: {
      type: 'template',
      template_name: templateName,
      template_language: 'en',
      template_components: components || [],
    },
  })
}

// WA-BLOCK — block/unblock the sender at Meta (Block API); the route
// mirrors the state locally (conversation.is_blocked + contacts.wa_status).
// The inbox spam/abuse action; protects the number's quality rating.
export function setBlocked(conversationId, blocked, locationId) {
  return api(`/api/whatsapp/conversations/${conversationId}/block`, {
    method: 'POST',
    locationId,
    body: { action: blocked ? 'block' : 'unblock' },
  })
}

// C6 — react to a customer message with an emoji via Meta. The route
// logs an outbound 'reaction' thread row (no optimistic rendering — the
// row shows on the next refresh), same semantics as the web inbox.
export function reactToInboundMessage(conversationId, waMessageId, emoji, locationId) {
  return api(`/api/whatsapp/conversations/${conversationId}/react`, {
    method: 'POST',
    locationId,
    body: { message_id: waMessageId, emoji },
  })
}

// C4 — operator-curated card sets (Settings → WhatsApp → Card sets),
// sendable as an in-session media carousel while the 24h window is open.
export async function listCardSets(locationId) {
  const res = await api(
    `/api/whatsapp/card-sets?location_id=${encodeURIComponent(locationId)}`,
    { locationId }
  )
  if (!res.success) return { success: false, error: res.error || 'Failed to load card sets' }
  return { success: true, data: res.sets || [] }
}

export function sendCardSet(conversationId, cardSetId, locationId) {
  return api(`/api/whatsapp/conversations/${conversationId}/send-carousel`, {
    method: 'POST',
    locationId,
    body: { card_set_id: cardSetId },
  })
}

// FLOW-SEND — drop the location's booking Flow ("Book your first visit")
// into an open conversation. Takes no body; the route requires a linked
// contact (the Flow books against it) and a configured Flow.
export function sendBookingFlow(conversationId, locationId) {
  return api(`/api/whatsapp/conversations/${conversationId}/send-flow`, {
    method: 'POST',
    locationId,
  })
}

// Resolve (or un-resolve) a conversation. Goes through the web PATCH
// route rather than a direct Supabase update because resolving a
// handed-off thread also RE-ARMS the agent server-side (AGENT-REARM.1)
// — that logic lives in the route, not in a trigger.
export function resolveConversation(conversationId, resolved, locationId) {
  return api(`/api/whatsapp/conversations/${conversationId}`, {
    method: 'PATCH',
    locationId,
    body: { resolved: !!resolved },
  })
}

// Rate one of Mia's replies (AGENT-QA.1). Upserts per (message, rater)
// server-side, so re-rating just overwrites.
export function rateAgentMessage({ messageId, rating, note, locationId }) {
  return api('/api/agent/feedback', {
    method: 'POST',
    locationId,
    body: {
      channel: 'whatsapp',
      message_id: messageId,
      rating,
      note: note || null,
    },
  })
}

// Needs-action badge count for the Messages tab (INBOX-EMAIL-M.1).
// Rides the same endpoint as the web sidebar badge (SIDEBAR-BADGES.2):
// conversations needing a human across all three channels (WhatsApp +
// Instagram + Email) at the active location, via the shared needsAction
// predicate — so the phone badge and the web badge can never disagree.
// Returns { success, data: { count } }.
export function getNeedsActionCount(locationId) {
  return api('/api/whatsapp/unread-count', { locationId })
}

export async function listTemplates(locationId) {
  let q = supabase.from('whatsapp_templates')
    .select('id, name, status, category, language, body_text, header_text')
    .eq('status', 'APPROVED')
    .order('name', { ascending: true })
  if (locationId) q = q.eq('location_id', locationId)
  const { data, error } = await q
  return error ? { success: false, error: error.message } : { success: true, data }
}
