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

// Vercel Pro ceiling is 300s. Combined with the chunked-resume
// model (Phase 5B) this lets a single tick dispatch up to ~1000
// recipients before yielding to the next tick (Twilio caps us at
// 25 sends/sec on alpha senders, so 1000 ≈ 40s of throughput plus
// headroom for slow Twilio responses).
export const maxDuration = 300

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()
  const nowIso = new Date().toISOString()

  // Pull rows the cron should work on:
  //   - scheduled with scheduled_at <= now: just-due, kick off.
  //   - sending: a previous tick (or a sync send) processed a chunk
  //     and parked the row here for resume. Phase 5B chunked-resume.
  // Service-role client bypasses RLS so all locations are scanned in
  // one query — exactly what we want for a global cron.
  const [scheduled, resuming] = await Promise.all([
    db.from('sms_broadcasts')
      .select('id, name, location_id, scheduled_at, status')
      .eq('status', 'scheduled')
      .lte('scheduled_at', nowIso)
      .order('scheduled_at', { ascending: true })
      .limit(10),
    db.from('sms_broadcasts')
      .select('id, name, location_id, scheduled_at, status')
      .eq('status', 'sending')
      .order('updated_at', { ascending: true })
      .limit(10),
  ])

  if (scheduled.error) {
    return NextResponse.json({ success: false, error: scheduled.error.message }, { status: 500 })
  }
  if (resuming.error) {
    return NextResponse.json({ success: false, error: resuming.error.message }, { status: 500 })
  }

  const due = [...(scheduled.data || []), ...(resuming.data || [])]

  const stats = {
    found: due.length,
    finished: 0,
    in_progress: 0,
    sent: 0,
    failed: 0,
    errors: [],
  }

  // Per-tick chunk size. Pro tier ceiling is 300s; Twilio caps
  // alpha senders at ~25 sends/sec; 1000 recipients ≈ 40s of
  // throughput plus headroom for slow Twilio responses and the
  // per-tick fanout to multiple broadcasts. Larger broadcasts
  // spread across multiple ticks (5 min apart).
  const CHUNK = 1000

  for (const row of due) {
    try {
      const result = await sendBroadcast(row.id, { maxRecipients: CHUNK })
      stats.sent += result.sent
      stats.failed += result.failed
      if (result.status === 'sent') stats.finished++
      else stats.in_progress++
    } catch (e) {
      const msg = e?.message || String(e)
      console.warn(`[cron run-sms-broadcasts] broadcast ${row.id} (${row.name}) failed: ${msg}`)
      stats.errors.push({ broadcast_id: row.id, error: msg })
      // Don't transition the broadcast — leave it in whatever state
      // sendBroadcast left it in. The next tick will pick it up
      // again from the recipients table's NOT-IN filter, so a
      // mid-chunk crash isn't a permanent stuck state.
    }
  }

  // Heartbeat AFTER the loop. If any broadcast threw, we still
  // stamp — the cron itself ran successfully; per-broadcast errors
  // are surfaced in the response body and the runtime logs.
  await stampHeartbeat('run-sms-broadcasts')

  return NextResponse.json({ success: true, stats })
}
