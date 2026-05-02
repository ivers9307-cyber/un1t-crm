// Vercel cron — every 5 minutes (matches sequences cron cadence).
// Picks up sms_broadcasts that are scheduled AND due, and dispatches
// them via sendBroadcast.
//
// Auth: Vercel cron jobs hit this URL with a CRON_SECRET bearer
// (same pattern run-sequences uses). Local invocation via the dev
// server requires the same bearer.
//
// State machine reminder (mig 061):
//   draft     -> user hasn't scheduled yet
//   scheduled -> user has set scheduled_at + transitioned via PATCH
//   sending   -> sendBroadcast set this; cron-protected from re-pickup
//   sent      -> done
//   cancelled -> aborted
//
// We only pick up status='scheduled'. sendBroadcast itself flips
// the row to 'sending' before iterating recipients, so a duplicate
// cron tick would short-circuit on the status check inside
// sendBroadcast.
//
// Errors per broadcast are logged but don't abort the loop — one
// broken row shouldn't block the rest of this tick's queue. The
// next tick will pick up anything still in 'scheduled' state.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { sendBroadcast } from '@/lib/sms'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Vercel default is 10s on Hobby, 60s on Pro. Bump to give headroom
// for a single tick to dispatch multiple broadcasts. The synchronous
// nature of sendBroadcast means a long broadcast can still hit this
// ceiling — Phase 2.6 (chunked resumable send) is the next iteration
// for very large audiences.
export const maxDuration = 60

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()
  const nowIso = new Date().toISOString()

  // Pull due broadcasts. Service-role client bypasses RLS so all
  // locations are scanned in one query — exactly what we want for
  // a global cron.
  const { data: due, error } = await db
    .from('sms_broadcasts')
    .select('id, name, location_id, scheduled_at')
    .eq('status', 'scheduled')
    .lte('scheduled_at', nowIso)
    .order('scheduled_at', { ascending: true })
    .limit(20) // cap per-tick fanout — anything beyond rolls to the next tick

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  const stats = { found: due?.length || 0, sent: 0, failed: 0, errors: [] }

  for (const row of (due || [])) {
    try {
      const result = await sendBroadcast(row.id)
      stats.sent += result.sent
      stats.failed += result.failed
    } catch (e) {
      const msg = e?.message || String(e)
      console.warn(`[cron run-sms-broadcasts] broadcast ${row.id} (${row.name}) failed: ${msg}`)
      stats.errors.push({ broadcast_id: row.id, error: msg })
      // Don't transition the broadcast to anything special — leave
      // it in whatever state sendBroadcast left it in (likely
      // 'sending' if it threw mid-loop). Manual cleanup if needed.
      // The next cron tick won't re-pick it because we filter on
      // status='scheduled'.
    }
  }

  // Heartbeat AFTER the loop. If any broadcast threw, we still
  // stamp — the cron itself ran successfully; per-broadcast errors
  // are surfaced in the response body and the runtime logs.
  await stampHeartbeat('run-sms-broadcasts')

  return NextResponse.json({ success: true, stats })
}
