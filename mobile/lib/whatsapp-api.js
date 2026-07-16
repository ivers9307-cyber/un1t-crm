// WhatsApp API helpers for mobile.
//
// Reads happen direct against Supabase (RLS enforces per-location
// scoping). Sending goes through the existing /api/whatsapp/conversations/[id]/send
// route which already uses session auth (works with our mobile JWT)
// and handles the 24-hour window check + Meta Graph API call.
//
// Marking a conversation read is also via direct Supabase update.

import { supabase } from './supabase'
import { api } from './api'

export async function listConversations(locationId) {
  let q = supabase.from('whatsapp_conversations')
    .select(`
      id, location_id, contact_id, wa_phone, wa_profile_name, status,
      last_message_at, last_message_direction, last_message_preview,
      unread_count, window_expires_at, assigned_to, created_at,
      resolved_at, agent_handed_off_at, agent_active,
      contacts:contact_id (id, name, first_name, last_name, pipeline_stage_slug)
    `)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(100)
  if (locationId) q = q.eq('location_id', locationId)
  const { data, error } = await q
  return error ? { success: false, error: error.message } : { success: true, data }
}

export async function getConversation(id) {
  const { data, error } = await supabase.from('whatsapp_conversations')
    .select(`
      *,
      contacts:contact_id (id, name, first_name, last_name, email, phone, wa_phone, pipeline_stage_slug)
    `)
    .eq('id', id)
    .single()
  return error ? { success: false, error: error.message } : { success: true, data }
}

export async function listMessages(conversationId, limit = 50) {
  // Newest-N reversed — ascending+limit returns the OLDEST rows, which
  // freezes the thread once a conversation outgrows the cap (web had the
  // identical bug; see the conversation [id] route).
  const { data, error } = await supabase.from('whatsapp_messages')
    .select('id, direction, message_type, body, media_url, media_external_id, media_storage_path, media_mime_type, status, sent_at, delivered_at, read_at, sent_by, source, template_name, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit)
  return error ? { success: false, error: error.message } : { success: true, data: (data || []).slice().reverse() }
}

export async function markConversationRead(conversationId) {
  const { error } = await supabase.from('whatsapp_conversations')
    .update({ unread_count: 0 })
    .eq('id', conversationId)
  return error ? { success: false, error: error.message } : { success: true }
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
