// GET /api/agent/decisions?conversation_id= — recent agent decisions for one
// conversation (FEAT-AGENT-TRACE.1). Backs the inbox "why did Mia reply / stay
// silent" trace. Location-scoped: only decisions at the caller's active location.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { hasPermission } from '@/lib/permissions'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'

// `whatsapp` at the active studio ('Forbidden' 403), then the active studio
// (400), in that order and with these texts, as before.
export const GET = withAuth(
  { permission: null, location: false, allow: (user) => hasPermission(user, 'whatsapp'), forbiddenMessage: 'Forbidden' },
  async ({ user, db, request }) => {
    const locationId = user.activeLocation?.id
    if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })

    const { searchParams } = new URL(request.url)
    const conversationId = searchParams.get('conversation_id')
    if (!conversationId) {
      return NextResponse.json({ success: false, error: 'conversation_id required' }, { status: 400 })
    }

    const { data, error } = await db
      .from('agent_decisions')
      .select('id, created_at, channel, decision, reason')
      .eq('conversation_id', conversationId)
      .eq('location_id', locationId)
      .order('created_at', { ascending: false })
      .limit(10)

    if (error) {
      logError('agent-decisions', 'read failed', { err: error, locationId })
      return NextResponse.json({ success: false, error: 'Could not load the decisions. Try again.' }, { status: 500 })
    }
    return NextResponse.json({ success: true, decisions: data || [] })
  },
)
