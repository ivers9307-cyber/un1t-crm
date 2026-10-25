import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404, requireWhatsAppInboxAnywhere, requireWhatsAppInboxAt } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { sendReaction } from '@/lib/whatsapp'
import { whatsappErrorStatus } from '@/lib/whatsapp-number-missing'
import { logError } from '@/lib/log'

// Shown to staff by the inbox when Meta took the reaction but its thread row was lost.
const THREAD_ROW_NOT_RECORDED = 'The reaction was sent to the customer, but it could not be saved to this thread, so it will not show here.'

// Empty emoji is valid — it removes an existing reaction — so no .min().
const ReactSchema = z.object({ message_id: z.string().min(1), emoji: z.string().max(8) })

// POST /api/whatsapp/conversations/[id]/react — react to a customer message
// with an emoji via Meta (empty string removes the reaction), then best-effort
// log a thread row (matching the inbound 'reaction' row style) so the action
// is visible in the inbox. Registered in src/lib/openapi.js.
export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  // INBOXLOC.1 — coarse pre-check (WhatsApp at any studio); the decision is
  // requireWhatsAppInboxAt at the conversation's studio, once the row is read.
  const perm = requireWhatsAppInboxAnywhere(user)
  if (perm) return perm

  const validation = await validateBody(request, ReactSchema)
  if (!validation.ok) return validation.response
  const { message_id, emoji } = validation.data

  const db = createServerClient()
  const { data: conversation, error: convErr } = await db.from('whatsapp_conversations')
    .select('id, location_id, contact_id, wa_phone')
    .eq('id', params.id)
    .maybeSingle()
  // CHECKINRISKS.1 — a failed read is not "no such conversation".
  if (convErr) {
    logError('wa-react', 'conversation read failed', { conversationId: params.id, err: convErr })
    return NextResponse.json({ success: false, error: 'Could not load the conversation just now.' }, { status: 500 })
  }
  if (!conversation) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, conversation.location_id)
  if (guard) return guard
  // INBOXLOC.1 — WhatsApp (web or mobile) judged at THIS studio, not the active one.
  const permHere = requireWhatsAppInboxAt(user, conversation.location_id)
  if (permHere) return permHere

  let sendResult
  try {
    // WAREPLYNUMBER.1 (C86) — Meta accepts a reaction only from the number
    // holding the message: the one this thread was written to.
    sendResult = await sendReaction(conversation.wa_phone, message_id, emoji, { locationId: conversation.location_id, replyInConversation: conversation.id })
  } catch (e) {
    // WACONFIGFALLBACK.1 — a location with no WhatsApp number of its own is a
    // 409 with the resolver's message (it used to send from the env number).
    return NextResponse.json({ success: false, error: e?.message || 'Meta reaction call failed' }, { status: whatsappErrorStatus(e, 502) })
  }

  // Best-effort thread row — mirrors the inbound reaction style
  // (`Reacted: <emoji>`); a logging failure never fails the action.
  // wa_message_id lets the reaction's 'sent' status webhook match the row.
  // CHECKINRISKS.1 (C106 e) — supabase-js RESOLVES with { error } rather than
  // throwing, so the try/catch that used to wrap this never saw a failed
  // insert. Meta already has the reaction: answer success (a failure would
  // invite a second send), log the loss structurally, and say so.
  const { error: rowErr } = await db.from('whatsapp_messages').insert({
    conversation_id: conversation.id,
    contact_id: conversation.contact_id || null,
    location_id: conversation.location_id,
    wa_message_id: sendResult?.messageId || null,
    direction: 'outbound',
    message_type: 'reaction',
    body: emoji ? `Reacted: ${emoji}` : 'Removed reaction',
    status: 'sent',
    // CHECKINSTALL.2 (C104 review) — deliberately NO sent_by: a reaction is
    // not a reply. The handoff SLA, handoff auto-resolve, and Mia's takeover
    // and re-arm checks read sent_by as "a person replied".
    sent_at: new Date().toISOString(),
  })
  if (rowErr) {
    logError('wa-react', 'thread row insert failed; the reaction was sent but is missing from the thread', {
      conversationId: conversation.id, locationId: conversation.location_id, err: rowErr,
    })
    // `warnings` is the send route's convention, which the inbox alerts.
    return NextResponse.json({ success: true, warnings: [THREAD_ROW_NOT_RECORDED] })
  }

  return NextResponse.json({ success: true })
}
