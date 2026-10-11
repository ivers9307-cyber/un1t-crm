// EVENTS-REMINDERS.1 — daily pre-event reminder cron (mig 384).
//
// Fires once a day (09:00 Europe/Dublin). Sends every CONFIRMED registrant of
// an event happening in exactly 3 days or exactly 1 day a reminder (email +
// best-effort push) carrying their check-in QR + the event time/location.
// Reminders are TRANSACTIONAL (the person booked) — not gated on marketing
// consent — but the hard administrative opt-out is respected. Idempotent via
// event_reminder_sends UNIQUE(registration_id, reminder_offset).
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { runEventReminders } from '@/lib/event-attendee-reminders'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  // TZ.9 — no pinned today: the lib counts "3 days out" / "tomorrow" from
  // each event's own studio day (Dublin events: the same day as before).
  const data = await runEventReminders({ db })

  await stampHeartbeat('event-reminders', data)
  return NextResponse.json({ success: true, data })
}
