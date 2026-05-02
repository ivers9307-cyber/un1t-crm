// Vercel cron — every 5 minutes.
// Picks up due sequence enrollments and fires the next step.
//
// Auth: Vercel cron jobs hit this URL with a CRON_SECRET bearer
// (the same pattern the other crons use). Local invocation via
// the dev server requires the same bearer.

import { NextResponse } from 'next/server'
import { runSequences, runEventReminderTriggers } from '@/lib/sequences'
import { runEventReminderSends } from '@/lib/event-reminders'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  // Three phases per tick — each independent so a failure in one
  // doesn't stop the others:
  //   1. event-level reminder sends (mig 044)
  //      Single-shot reminders attached to event_types. Cheapest path
  //      for "send a WhatsApp 24h before each booking" without an
  //      operator authoring a sequence.
  //   2. sequence event_reminder triggers
  //      Multi-step reminder flows configured as sequences.
  //   3. runSequences()
  //      Pick up due enrolments and send the next step.
  let reminderSendStats = null, reminderSendErr = null
  try { reminderSendStats = await runEventReminderSends() }
  catch (e) {
    reminderSendErr = e.message || String(e)
    console.warn(`[cron] event-reminder sends failed: ${reminderSendErr}`)
  }

  let triggerStats = null, triggerErr = null
  try { triggerStats = await runEventReminderTriggers() }
  catch (e) {
    triggerErr = e.message || String(e)
    console.warn(`[cron] event_reminder triggers failed: ${triggerErr}`)
  }

  try {
    const stats = await runSequences()
    // Heartbeat AFTER all three phases ran. If runSequences threw we
    // skip the stamp — that's the signal a downstream alert needs.
    await stampHeartbeat('run-sequences')
    return NextResponse.json({
      success: true,
      stats,
      triggers: triggerStats,
      trigger_error: triggerErr,
      reminder_sends: reminderSendStats,
      reminder_sends_error: reminderSendErr,
    })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || String(e) }, { status: 500 })
  }
}
