import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'

// GET /api/whatsapp/conversations/[id] — get conversation with messages
export async function GET(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { searchParams } = new URL(request.url)
  const limit = parseInt(searchParams.get('limit') || '50')

  const { data: conversation, error } = await db.from('whatsapp_conversations')
    .select('*, contacts!contact_id(id, name, first_name, email, phone, wa_phone, pipeline_stage_slug)')
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
