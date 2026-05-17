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

// Vercel Pro ceiling is 300s. The chunk-and-resume model (Phase 5B)
// means anything bigger rolls to the cron, but raising this lets the
// manual "Send now" finish broadcasts up to ~2000 recipients in one
// shot instead of punting after ~500.
export const maxDuration = 300

export async function POST(request, props) {
  const params = await props.params;
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
    // Manual "Send now" — process up to 2000 recipients in this
    // request on the Pro tier (300s ceiling). At Twilio's 25/sec
    // rate limit that's ~80s of throughput plus headroom; bigger
    // audiences chunk-resume via the every-5-min cron (Phase 5B).
    const result = await sendBroadcast(params.id, { maxRecipients: 2000 })
    return NextResponse.json({ success: true, ...result })
  } catch (err) {
    console.error('[sms/broadcasts/send]', err)
    return NextResponse.json({ success: false, error: err.message || 'Send failed' }, { status: 500 })
  }
}
