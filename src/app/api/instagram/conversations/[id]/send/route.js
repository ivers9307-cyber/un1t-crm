import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { sendInstagramMessage } from '@/lib/agent/instagram'
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

  const validation = await validateBody(request, SendSchema)
  if (!validation.ok) return validation.response
  const { text } = validation.data

  const db = createServerClient()
  const { data: conversation, error } = await db.from('instagram_conversations')
    .select('*, contacts(id, name, first_name)')
    .eq('id', params.id)
    .single()

  if (error || !conversation) {
    return NextResponse.json({ success: false, error: 'Conversation not found' }, { status: 404 })
  }

  const guard = assertLocationAccess(user, conversation.location_id)
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
    result = await sendInstagramMessage(conversation.ig_user_id, text, { connection: { access_token: token } })
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message }, { status: 400 })
  }

  const now = new Date().toISOString()
  await db.from('instagram_messages').insert({
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

  // Take over: stop the agent + stamp the thread.
  await db.from('instagram_conversations').update({
    last_message_at: now,
    last_message_direction: 'outbound',
    last_message_preview: text.substring(0, 100),
    agent_active: false,
    agent_handed_off_at: conversation.agent_handed_off_at || now,
    updated_at: now,
  }).eq('id', params.id)

  return NextResponse.json({ success: true, messageId: result.messageId, agent_active: false })
}
