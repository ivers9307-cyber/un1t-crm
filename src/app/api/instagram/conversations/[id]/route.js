import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'

// GET /api/instagram/conversations/[id] — conversation + messages thread.
// Mirrors the WhatsApp single-conversation route. Resets unread_count.
export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

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
  const guard = assertLocationAccess(user, conversation.location_id)
  if (guard) return guard

  const { data: messages } = await db.from('instagram_messages')
    .select('*')
    .eq('conversation_id', params.id)
    .order('created_at', { ascending: true })
    .limit(limit)

  // Mark as read.
  await db.from('instagram_conversations')
    .update({ unread_count: 0 })
    .eq('id', params.id)

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

  const body = await request.json().catch(() => null)
  if (!body || typeof body.resolved !== 'boolean') {
    return NextResponse.json({ success: false, error: 'Body must be { resolved: boolean }' }, { status: 400 })
  }

  const db = createServerClient()
  const { data: conversation, error } = await db.from('instagram_conversations')
    .select('id, location_id')
    .eq('id', params.id)
    .single()
  if (error || !conversation) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, conversation.location_id)
  if (guard) return guard

  const { error: upErr } = await db.from('instagram_conversations')
    .update({ resolved_at: body.resolved ? new Date().toISOString() : null })
    .eq('id', params.id)
  if (upErr) return NextResponse.json({ success: false, error: upErr.message }, { status: 500 })

  return NextResponse.json({ success: true, resolved: body.resolved })
}
