import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { sendBroadcast } from '@/lib/whatsapp'

// POST /api/whatsapp/broadcasts/[id]/send
export async function POST(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'whatsapp')) {
    return NextResponse.json({ success: false, error: 'Forbidden — WhatsApp not enabled' }, { status: 403 })
  }

  // Authorise BEFORE we let sendBroadcast take over — it's an
  // internal helper and doesn't repeat the location check. (Mirrors
  // the SMS sibling; this route previously had no guard at all, so
  // any authenticated principal could fire any broadcast by id.)
  const db = createServerClient()
  const { data: row } = await db.from('whatsapp_broadcasts').select('location_id').eq('id', params.id).single()
  if (!row) return NextResponse.json({ success: false, error: 'Broadcast not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, row.location_id)
  if (guard) return guard

  try {
    const result = await sendBroadcast(params.id)
    return NextResponse.json({ success: true, ...result })
  } catch (error) {
    console.error('Broadcast send error:', error)
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 400 }
    )
  }
}
