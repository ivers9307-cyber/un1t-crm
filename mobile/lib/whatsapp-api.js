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
  const { data, error } = await supabase.from('whatsapp_messages')
    .select('id, direction, message_type, body, media_url, media_mime_type, status, sent_at, delivered_at, read_at, sent_by, template_name, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(limit)
  return error ? { success: false, error: error.message } : { success: true, data }
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

export async function listTemplates(locationId) {
  let q = supabase.from('whatsapp_templates')
    .select('id, name, status, category, language, body_text, header_text')
    .eq('status', 'APPROVED')
    .order('name', { ascending: true })
  if (locationId) q = q.eq('location_id', locationId)
  const { data, error } = await q
  return error ? { success: false, error: error.message } : { success: true, data }
}
