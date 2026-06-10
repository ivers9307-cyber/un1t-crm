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
