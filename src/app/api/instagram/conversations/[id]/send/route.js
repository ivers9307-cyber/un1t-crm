import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404, requireInboxPermission } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { sendInstagramMessage, markInstagramSeen } from '@/lib/agent/instagram'
import { resolveChannelConnection } from '@/lib/agent/channels'

const SendSchema = z.object({
  text: z.string().trim().min(1).max(1000),
  sent_by: z.string().max(200).nullable().optional(),
})

// POST /api/instagram/conversations/[id]/send — operator manual reply.
//
// Sending as a human is also a TAKE-OVER: we set agent_active = false so
// the auto-responder stops replying in this thread (core.js skips when
// agent_active === false). Staff stay in control until/unless they
// re-enable the agent elsewhere.
export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  // Channel permission — service-role client, so this IS the gate (INBOX-PERM.1).
  const perm = requireInboxPermission(user, 'ig')
  if (perm) return perm

  const validation = await validateBody(request, SendSchema)
  if (!validation.ok) return validation.response
  const { text } = validation.data

  const db = createServerClient()
  const { data: conversation, error } = await db.from('instagram_conversations')
    .select('*, contacts!contact_id(id, name, first_name)')
    .eq('id', params.id)
    .single()

  if (error || !conversation) {
    return NextResponse.json({ success: false, error: 'Conversation not found' }, { status: 404 })
  }

  const guard = assertLocationAccessOr404(user, conversation.location_id)
  if (guard) return guard

  if (!conversation.ig_user_id) {
    return NextResponse.json({ success: false, error: 'No Instagram recipient for this conversation' }, { status: 400 })
  }

  // Resolve the location's active Instagram connection. resolveChannelConnection
  // returns the raw row (access_token intact — server-side use only) or null.
  const conn = await resolveChannelConnection(conversation.location_id, 'instagram', db)
  if (!conn) {
    return NextResponse.json({ success: false, error: 'No active Instagram connection for this location' }, { status: 400 })
  }
  const token = conn.access_token
  if (!token) {
    return NextResponse.json({ success: false, error: 'Instagram connection has no access token' }, { status: 400 })
  }

  let result
  try {
    // Pass the full connection row (not just the token) so sendInstagramMessage
    // sends via the explicit account id and can stamp connection health
    // (last_ok_at / auth-error status, INTEG-A3) on the row.
    result = await sendInstagramMessage(conversation.ig_user_id, text, { connection: conn })
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message }, { status: 400 })
  }

  // IG-SEEN.1 — a reply through the API is not a read receipt, so without
  // this the thread stays bold in the Instagram app after staff have already
  // answered it here. Richard's call: mark on REPLY, not on open — a reply is
  // unambiguous proof a human dealt with it, whereas opening a thread in the
  // inbox is not. Fire-and-forget: the message is already delivered, and a
  // courtesy signal must never turn a successful send into an error.
  // Awaited deliberately: an un-awaited promise in a serverless handler is not
  // guaranteed to run once the response is sent, so fire-and-forget would fix
  // this only sometimes — and invisibly, since the helper's own logging would
  // never execute either. markInstagramSeen can't throw (every path is caught
  // and it returns a boolean), so awaiting still cannot fail a send that has
  // already been delivered.
  await markInstagramSeen(conversation.ig_user_id, { connection: conn })

  const now = new Date().toISOString()
  // BAREWRITE.1 — both writes below were bare awaits. Meta has ALREADY
  // delivered the DM at this point, so neither failure may un-send it and
  // neither may 500 the request; but both were previously invisible, and each
  // has a real consequence: a lost message row means the operator's own reply
  // never appears in the thread (they retype it, the customer gets it twice),
  // and a lost conversation stamp leaves agent_active TRUE so Mia keeps
  // replying on a thread a human just took over. Report them on the success
  // response as warnings so the inbox can surface the mismatch.
  const warnings = []
  const { error: messageError } = await db.from('instagram_messages').insert({
    conversation_id: params.id,
    contact_id: conversation.contact_id || null,
    location_id: conversation.location_id,
    ig_message_id: result.messageId,
    direction: 'outbound',
    message_type: 'text',
    body: text,
    status: 'sent',
    source: 'operator',
    sent_at: now,
  })
  if (messageError) {
    console.error('[ig-send] message delivered but not recorded:', messageError.message)
    warnings.push('The message was delivered but could not be saved to the thread — do not resend it.')
  }

  // Take over: stop the agent + stamp the thread.
  const { error: threadError } = await db.from('instagram_conversations').update({
    last_message_at: now,
    last_message_direction: 'outbound',
    last_message_preview: text.substring(0, 100),
    agent_active: false,
    agent_handed_off_at: conversation.agent_handed_off_at || now,
    updated_at: now,
  }).eq('id', params.id)
  if (threadError) {
    console.error('[ig-send] take-over stamp failed — Mia may still be active on this thread:', threadError.message)
    warnings.push('The message was delivered but Mia could not be paused on this thread — pause her manually.')
  }

  return NextResponse.json({
    success: true,
    messageId: result.messageId,
    agent_active: !!threadError,
    ...(warnings.length ? { warnings } : {}),
  })
}
