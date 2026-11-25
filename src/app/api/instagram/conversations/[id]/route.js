import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { assertLocationAccessOr404, requireWhatsAppInboxAnywhere, requireWhatsAppInboxAt } from '@/lib/auth'
import { logError } from '@/lib/log'
import { resolveRearmPatch } from '@/lib/agent/core'
import { completePatch } from '@/lib/inbox-state'
import { validateBody } from '@/lib/validate'
import { readHandledByName } from '@/lib/handled-by-name'

const PatchConversationBody = z.object({
  resolved: z.boolean(),
})

// GET /api/instagram/conversations/[id] — conversation + messages thread.
// Mirrors the WhatsApp single-conversation route. Resets unread_count.
// withAuth only signs the caller in (the same 401); the channel permission,
// the row (404) and its studio (404) keep their order.
export const GET = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {

  // Channel permission — service-role client, so this IS the gate (INBOX-PERM.1).
  // SECGAPS.1 — 'ig' rides the `whatsapp` key (no Instagram key exists): a
  // coarse any-studio check here, the decision at the conversation's own
  // studio once it is read (the WhatsApp thread routes' INBOXLOC.1 rule).
  // INBOXPERM.1 — web OR phone key (the phone calls this route), the pair the
  // WhatsApp thread routes take. The "WhatsApp" in the helper names is the key.
  const perm = requireWhatsAppInboxAnywhere(user)
  if (perm) return perm

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
  const permHere = requireWhatsAppInboxAt(user, conversation.location_id)
  if (permHere) return permHere

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

  // INBOXFOLLOW.2 — the assignee's first name for "Handled by" (Instagram
  // messages record no sender, so there is no newest-sender fallback here).
  conversation.handled_by_name = await readHandledByName(db, 'ig', conversation)

  return NextResponse.json({ success: true, conversation, messages: messages || [] })
})


// PATCH /api/instagram/conversations/[id] — operator workflow state.
// Body: { resolved: boolean } -> stamps/clears resolved_at (UIX-P1,
// mig 255). Resolve drops the thread out of the unified inbox's
// "Needs reply" queue; a new inbound message auto-clears it in the
// webhook so replied-to threads come back.
export const PATCH = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {

  // Channel permission — service-role client, so this IS the gate (INBOX-PERM.1).
  // SECGAPS.1 — 'ig' rides the `whatsapp` key (no Instagram key exists): a
  // coarse any-studio check here, the decision at the conversation's own
  // studio once it is read (the WhatsApp thread routes' INBOXLOC.1 rule).
  // INBOXPERM.1 — web OR phone key (the phone calls this route), the pair the
  // WhatsApp thread routes take. The "WhatsApp" in the helper names is the key.
  const perm = requireWhatsAppInboxAnywhere(user)
  if (perm) return perm

  const validation = await validateBody(request, PatchConversationBody)
  if (!validation.ok) return validation.response
  const body = validation.data

  const { data: conversation, error } = await db.from('instagram_conversations')
    .select('id, location_id, agent_handed_off_at')
    .eq('id', params.id)
    .single()
  if (error || !conversation) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, conversation.location_id)
  if (guard) return guard
  const permHere = requireWhatsAppInboxAt(user, conversation.location_id)
  if (permHere) return permHere

  // AGENT-REARM.1 — resolving a handed-off thread hands it straight back
  // to the agent: the human engagement is closed, the agent is on duty
  // again for the next inbound. resolveRearmPatch is a no-op otherwise.
  const { error: upErr } = await db.from('instagram_conversations')
    .update({
      resolved_at: body.resolved ? new Date().toISOString() : null,
      ...resolveRearmPatch({ resolved: body.resolved, agent_handed_off_at: conversation.agent_handed_off_at }),
      // INBOXFOLLOW.1 — completing a thread closes every follow-up state; reopening changes none.
      ...(body.resolved ? completePatch() : {}),
    })
    .eq('id', params.id)
  if (upErr) {
    logError('ig-conversation', 'resolve update failed', { conversationId: params.id, err: upErr })
    return NextResponse.json({ success: false, error: 'Could not update the conversation. Try again.' }, { status: 500 })
  }

  return NextResponse.json({ success: true, resolved: body.resolved })
})
