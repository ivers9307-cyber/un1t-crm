import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404, requireInboxPermission } from '@/lib/auth'
import { validateBody } from '@/lib/validate'

const PatchConversationBody = z.object({
  resolved: z.boolean(),
})

// GET /api/email/conversations/[id] — conversation + messages thread
// (EMAIL-INBOX.1). Mirrors the Instagram single-conversation route.
// Resets unread_count on open.
export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  // Channel permission — service-role client, so this IS the gate. The `em`
  // channel resolves to the `email_inbox` key (INBOX-PERM.2); it used to
  // resolve to `whatsapp`, which opened this route to anyone with the WhatsApp
  // inbox and no email access at all.
  const perm = requireInboxPermission(user, 'em')
  if (perm) return perm

  const db = createServerClient()
  const { searchParams } = new URL(request.url)
  const limit = parseInt(searchParams.get('limit') || '50')

  const { data: conversation, error } = await db.from('email_conversations')
    .select('*, contacts!contact_id(id, name, first_name, email, pipeline_stage_slug)')
    .eq('id', params.id)
    .single()

  if (error || !conversation) {
    return NextResponse.json({ success: false, error: 'Conversation not found' }, { status: 404 })
  }

  // Caller must belong to the conversation's location (404, not 403 —
  // don't confirm the id exists).
  const guard = assertLocationAccessOr404(user, conversation.location_id)
  if (guard) return guard

  // Newest rows first then reversed for display — same fix as the IG
  // route (ascending+limit freezes the pane once a thread outgrows the
  // cap). html_body is deliberately NOT selected: the thread renders
  // text_body only, and quoted HTML chains can be hundreds of KB.
  const { data: messagesDesc } = await db.from('email_inbox_messages')
    .select('id, conversation_id, contact_id, location_id, direction, from_email, to_email, subject, text_body, postmark_message_id, source, status, sent_at, created_at')
    .eq('conversation_id', params.id)
    .order('created_at', { ascending: false })
    .limit(limit)
  const messages = (messagesDesc || []).slice().reverse()

  // Mark as read.
  await db.from('email_conversations')
    .update({ unread_count: 0 })
    .eq('id', params.id)

  return NextResponse.json({ success: true, conversation, messages })
}

// PATCH /api/email/conversations/[id] — operator workflow state.
// Body: { resolved: boolean } → stamps/clears resolved_at (UIX-P1
// semantics). No agent-rearm here — the email channel has no customer
// agent; resolve is purely the queue state.
export async function PATCH(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  // Channel permission — service-role client, so this IS the gate. The `em`
  // channel resolves to the `email_inbox` key (INBOX-PERM.2); it used to
  // resolve to `whatsapp`, which opened this route to anyone with the WhatsApp
  // inbox and no email access at all.
  const perm = requireInboxPermission(user, 'em')
  if (perm) return perm

  const validation = await validateBody(request, PatchConversationBody)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()
  const { data: conversation, error } = await db.from('email_conversations')
    .select('id, location_id')
    .eq('id', params.id)
    .single()
  if (error || !conversation) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, conversation.location_id)
  if (guard) return guard

  const { error: upErr } = await db.from('email_conversations')
    .update({ resolved_at: body.resolved ? new Date().toISOString() : null })
    .eq('id', params.id)
  if (upErr) return NextResponse.json({ success: false, error: upErr.message }, { status: 500 })

  return NextResponse.json({ success: true, resolved: body.resolved })
}
