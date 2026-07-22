// GET /api/agent/decisions?conversation_id= — recent agent decisions for one
// conversation (FEAT-AGENT-TRACE.1). Backs the inbox "why did Mia reply / stay
// silent" trace. Location-scoped: only decisions at the caller's active location.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'whatsapp')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })

  const { searchParams } = new URL(request.url)
  const conversationId = searchParams.get('conversation_id')
  if (!conversationId) {
    return NextResponse.json({ success: false, error: 'conversation_id required' }, { status: 400 })
  }

  const db = createServerClient()
  const { data, error } = await db
    .from('agent_decisions')
    .select('id, created_at, channel, decision, reason')
    .eq('conversation_id', conversationId)
    .eq('location_id', locationId)
    .order('created_at', { ascending: false })
    .limit(10)

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, decisions: data || [] })
}
