import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404, requireInboxPermission } from '@/lib/auth'
import { resolveRearmPatch } from '@/lib/agent/core'
import { validateBody } from '@/lib/validate'

const PatchConversationBody = z.object({
  resolved: z.boolean(),
})

// GET /api/instagram/conversations/[id] — conversation + messages thread.
// Mirrors the WhatsApp single-conversation route. Resets unread_count.
export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  // Channel permission — service-role client, so this IS the gate (INBOX-PERM.1).
  const perm = requireInboxPermission(user, 'ig')
  if (perm) return perm

  const db = createServerClient()
  const { searchParams } = new URL(request.url)
  const limit = parseInt(searchParams.get('limit') || '50')

  const { data: conversation, error } = await db.from('instagram_conversations')
    .select('*, contacts!contact_id(id, name, first_name, email, pipeline_stage_slug)')
    .eq('id', params.id)
    .single()

  if (error || !conversation) {
    return NextResponse.json({ success: false, error: 'Conversation not found' }, { status: 404 })
  }

  // Caller must belong to the conversation's location.
  const guard = assertLocationAccessOr404(user, conversation.location_id)
  if (guard) return guard

  // Newest rows first then reversed for display — ascending+limit returns
  // the OLDEST rows, which froze the thread pane once a conversation
  // outgrew the cap (2026-06-12: a 55-message thread showed only its
  // first 50; new messages and the operator's own sends never appeared).
  const { data: messagesDesc } = await db.from('instagram_messages')
    .select('*')
    .eq('conversation_id', params.id)
    .order('created_at', { ascending: false })
    .limit(limit)
  const messages = (messagesDesc || []).slice().reverse()

  // Mark as read. BAREWRITE.1 — genuinely best-effort: this is a side effect
  // of READING the thread, and a failed clear only means the unread badge
  // lingers until the next open. The error is read and logged rather than
  // discarded, so a systematic failure is visible.
  const { error: readError } = await db.from('instagram_conversations')
    .update({ unread_count: 0 })
    .eq('id', params.id)
  if (readError) console.error('[ig-conversation] clearing unread_count failed (non-fatal):', readError.message)

  return NextResponse.json({ success: true, conversation, messages: messages || [] })
}


// PATCH /api/instagram/conversations/[id] — operator workflow state.
// Body: { resolved: boolean } -> stamps/clears resolved_at (UIX-P1,
// mig 255). Resolve drops the thread out of the unified inbox's
// "Needs reply" queue; a new inbound message auto-clears it in the
// webhook so replied-to threads come back.
export async function PATCH(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  // Channel permission — service-role client, so this IS the gate (INBOX-PERM.1).
  const perm = requireInboxPermission(user, 'ig')
  if (perm) return perm

  const validation = await validateBody(request, PatchConversationBody)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()
  const { data: conversation, error } = await db.from('instagram_conversations')
    .select('id, location_id, agent_handed_off_at')
    .eq('id', params.id)
    .single()
  if (error || !conversation) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, conversation.location_id)
  if (guard) return guard

  // AGENT-REARM.1 — resolving a handed-off thread hands it straight back
  // to the agent: the human engagement is closed, the agent is on duty
  // again for the next inbound. resolveRearmPatch is a no-op otherwise.
  const { error: upErr } = await db.from('instagram_conversations')
    .update({
      resolved_at: body.resolved ? new Date().toISOString() : null,
      ...resolveRearmPatch({ resolved: body.resolved, agent_handed_off_at: conversation.agent_handed_off_at }),
    })
    .eq('id', params.id)
  if (upErr) return NextResponse.json({ success: false, error: upErr.message }, { status: 500 })

  return NextResponse.json({ success: true, resolved: body.resolved })
}
