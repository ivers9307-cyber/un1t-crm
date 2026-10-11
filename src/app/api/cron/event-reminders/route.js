// EVENTS-REMINDERS.1 — daily pre-event reminder cron (mig 384).
//
// Sends every CONFIRMED registrant of an event happening in exactly 3 days or
// exactly 1 day a reminder (email + best-effort push) carrying their check-in
// QR + the event time/location. Reminders are TRANSACTIONAL (the person
// booked) — not gated on marketing consent — but the hard administrative
// opt-out is respected. Idempotent via event_reminder_sends
// UNIQUE(registration_id, reminder_offset).
//
// TZ.6 — the schedule is hourly; each event's location acts at its daily slot:
// 09:00 UTC for a Europe/Dublin studio (as before), 09:00 local for any other
// zone, at most once per local day (src/lib/cron-daily-slot.js). "3 days" and
// "1 day" count from that location's own today.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { runEventReminders } from '@/lib/event-attendee-reminders'
import { gateDailySlot, slotFor } from '@/lib/cron-daily-slot'
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
  const gate = await gateDailySlot(db, 'event-reminders', { module: 'event-reminders' })
  if (!gate.ok) return NextResponse.json({ success: false, error: 'locations unreadable', slot: gate.summary }, { status: 500 })

  const data = gate.slots.size === 0
    ? { events: 0, sent: 0, skipped: 0 }
    : await runEventReminders({
      db,
      todayFor: (locationId) => slotFor(gate.slots, locationId)?.day,
      todays: [...new Set([...gate.slots.values()].map((s) => s.day))],
    })

  await stampHeartbeat('event-reminders', { ...data, slot: gate.summary })
  return NextResponse.json({ success: true, data: { ...data, slot: gate.summary } })
}
