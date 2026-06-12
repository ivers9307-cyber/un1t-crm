import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { resolveRearmPatch } from '@/lib/agent/core'

// GET /api/whatsapp/conversations/[id] — get conversation with messages
export async function GET(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { searchParams } = new URL(request.url)
  const limit = parseInt(searchParams.get('limit') || '50')

  const { data: conversation, error } = await db.from('whatsapp_conversations')
    .select('*, contacts!contact_id(id, name, first_name, email, phone, wa_phone, pipeline_stage_slug, wa_status)')
    .eq('id', params.id)
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 404 })

  // Caller must belong to the conversation's location (mirrors the
  // /send and /add-contact siblings — this GET previously had no
  // guard, exposing thread bodies + contact PII to any principal).
  const guard = assertLocationAccess(user, conversation.location_id)
  if (guard) return guard

  // Get messages
  const { data: messages } = await db.from('whatsapp_messages')
    .select('*')
    .eq('conversation_id', params.id)
    .order('created_at', { ascending: true })
    .limit(limit)

  // Mark as read (reset unread count)
  await db.from('whatsapp_conversations')
    .update({ unread_count: 0 })
    .eq('id', params.id)

  return NextResponse.json({
    success: true,
    conversation,
    messages: messages || [],
  })
}


// PATCH /api/whatsapp/conversations/[id] — operator workflow state.
// Body: { resolved: boolean } -> stamps/clears resolved_at (UIX-P1,
// mig 255). Resolve drops the thread out of the unified inbox's
// "Needs reply" queue; a new inbound message auto-clears it in the
// webhook so replied-to threads come back.
export async function PATCH(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => null)
  if (!body || typeof body.resolved !== 'boolean') {
    return NextResponse.json({ success: false, error: 'Body must be { resolved: boolean }' }, { status: 400 })
  }

  const db = createServerClient()
  const { data: conversation, error } = await db.from('whatsapp_conversations')
    .select('id, location_id, agent_handed_off_at')
    .eq('id', params.id)
    .single()
  if (error || !conversation) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, conversation.location_id)
  if (guard) return guard

  // AGENT-REARM.1 — resolving a handed-off thread hands it straight back
  // to the agent: the human engagement is closed, the agent is on duty
  // again for the next inbound. resolveRearmPatch is a no-op otherwise.
  const { error: upErr } = await db.from('whatsapp_conversations')
    .update({
      resolved_at: body.resolved ? new Date().toISOString() : null,
      ...resolveRearmPatch({ resolved: body.resolved, agent_handed_off_at: conversation.agent_handed_off_at }),
    })
    .eq('id', params.id)
  if (upErr) return NextResponse.json({ success: false, error: upErr.message }, { status: 500 })

  return NextResponse.json({ success: true, resolved: body.resolved })
}
