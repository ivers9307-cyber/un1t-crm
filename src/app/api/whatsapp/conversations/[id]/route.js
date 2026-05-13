import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'

// GET /api/whatsapp/conversations/[id] — get conversation with messages
export async function GET(request, { params }) {
  const db = createServerClient()
  const { searchParams } = new URL(request.url)
  const limit = parseInt(searchParams.get('limit') || '50')

  const { data: conversation, error } = await db.from('whatsapp_conversations')
    .select('*, contacts(id, name, first_name, email, phone, wa_phone, pipeline_stage_slug)')
    .eq('id', params.id)
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 404 })

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
