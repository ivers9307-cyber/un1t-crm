// Vercel cron — every 5 minutes.
// Picks up due sequence enrollments and fires the next step.
//
// Auth: Vercel cron jobs hit this URL with a CRON_SECRET bearer
// (the same pattern the other crons use). Local invocation via
// the dev server requires the same bearer.

import { NextResponse } from 'next/server'
import { runSequences, runEventReminderTriggers } from '@/lib/sequences'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  // Two phases per tick:
  //   1. event_reminder triggers — find bookings ~N hours away and
  //      create enrolments. Runs first so any newly-due reminders
  //      get processed in the same tick they're scheduled for
  //      (next_step_at = NOW() at insert).
  //   2. runSequences() — pick up due enrolments and fire steps.
  // Independent — failure in (1) doesn't stop (2).
  let triggerStats = null
  let triggerError = null
  try {
    triggerStats = await runEventReminderTriggers()
  } catch (e) {
    triggerError = e.message || String(e)
    console.warn(`[cron] event_reminder triggers failed: ${triggerError}`)
  }

  try {
    const stats = await runSequences()
    return NextResponse.json({ success: true, stats, triggers: triggerStats, trigger_error: triggerError })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || String(e) }, { status: 500 })
  }
}
