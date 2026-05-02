// POST /api/sms/broadcasts/[id]/send — kick off a broadcast.
//
// Synchronous from the caller's perspective (mirrors WA's send flow).
// Long broadcasts will hit Vercel's serverless timeout — Phase 2.5
// will move this to a queued worker / cron pull. For now, fine for
// up-to-a-few-hundred-recipient sends.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { sendBroadcast } from '@/lib/sms'

export const runtime = 'nodejs'

// Vercel default is 10s on the Hobby plan, 60s on Pro. Bump to give
// the loop room. If your account is on Pro, raise this further.
export const maxDuration = 60

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'sms')) {
    return NextResponse.json({ success: false, error: 'Forbidden — SMS not enabled' }, { status: 403 })
  }

  // Authorise BEFORE we let sendBroadcast take over — it's an
  // internal helper and doesn't repeat the location check.
  const db = createServerClient()
  const { data: row } = await db.from('sms_broadcasts').select('location_id').eq('id', params.id).single()
  if (!row) return NextResponse.json({ success: false, error: 'Broadcast not found' }, { status: 404 })
  const guard = assertLocationAccess(user, row.location_id)
  if (guard) return guard

  try {
    const result = await sendBroadcast(params.id)
    return NextResponse.json({ success: true, ...result })
  } catch (err) {
    console.error('[sms/broadcasts/send]', err)
    return NextResponse.json({ success: false, error: err.message || 'Send failed' }, { status: 500 })
  }
}
