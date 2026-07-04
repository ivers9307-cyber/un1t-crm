import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess , getUserLocationIds} from '@/lib/auth'

// GET /api/whatsapp/conversations — list conversations (inbox)
export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  let query = db.from('whatsapp_conversations')
    .select('*, contacts!contact_id(id, name, first_name, phone, wa_phone, pipeline_stage_slug)')
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(50)

  if (locationId) {
    query = query.eq('location_id', locationId)
  } else {
    const userLocationIds = getUserLocationIds(user)
    if (userLocationIds.length === 0) return NextResponse.json({ success: true, conversations: [] })
    query = query.in('location_id', userLocationIds)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  // INBOX-APPROVALS — flag threads with a pending agent request so the
  // queue can badge them. One batched query over this page's ids (≤50).
  const conversations = data || []
  if (conversations.length) {
    const { data: pend } = await db.from('agent_membership_requests')
      .select('conversation_id')
      .eq('status', 'pending')
      .in('conversation_id', conversations.map(c => c.id))
    const pendingSet = new Set((pend || []).map(r => r.conversation_id))
    for (const c of conversations) c.pending_approval = pendingSet.has(c.id)
  }

  return NextResponse.json({ success: true, conversations })
}
