import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { computeAvailableSlots } from '@/lib/booking-slots'

// GET /api/public/bookings/:slug/slots?date=2026-04-28
// Returns available time slots for a given date.
//
// PATH HISTORY: lived at /api/public/events/[slug]/slots until the
// events expansion (E3 / commit 6f6911a) — the multi-kind events
// feature claimed the /api/public/events/* prefix. Calendly slots
// follow the templates over to /api/public/bookings/* (E2 named the
// templates "booking types" and lives at /bookings/event-types/* on
// the operator side; the public surface is just /book/[slug] with
// its API at /api/public/bookings/[slug]).
//
// TIMEZONE NOTES (incident 2026-05-11): all date comparisons in
// this route are in Europe/Dublin local time, NOT server (UTC) time.
//   - "today" / "max date" use dublinTodayStr() so a customer
//     booking just after Dublin midnight (= UTC 23:00 prev day)
//     doesn't see yesterday treated as today.
//   - The current-day past-time filter uses dublinNowMinutes()
//     because slot.start strings in availability JSON are stored
//     as Dublin local times. Comparing them to UTC clock time
//     would (in BST) leak slots that are already past in Dublin.
//   - The day-of-week lookup parses the input date string as UTC
//     midnight + getUTCDay() so the weekday is stable regardless
//     of where the route runs (Vercel UTC or local dev machine).
export async function GET(request, props) {
  const params = await props.params;
  const db = createServerClient()
  const { searchParams } = new URL(request.url)
  const date = searchParams.get('date')

  if (!date) {
    return NextResponse.json({ success: false, error: 'date parameter is required (YYYY-MM-DD)' }, { status: 400 })
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ success: false, error: 'date must be YYYY-MM-DD' }, { status: 400 })
  }

  // Get event type
  const { data: event, error: eventErr } = await db.from('event_types')
    .select('id, duration_minutes, availability, buffer_minutes, max_advance_days')
    .eq('slug', params.slug)
    .eq('active', true)
    .single()

  if (eventErr || !event) {
    return NextResponse.json({ success: false, error: 'Booking type not found' }, { status: 404 })
  }

  // AGENT-HANDS.1 — the slot machinery (range checks, weekday lookup,
  // generation, booked/blocked subtraction, today's past-time filter)
  // was extracted verbatim to src/lib/booking-slots.js so the customer
  // agent's consultation tools share the exact logic. Behaviour here
  // is unchanged; see the lib for the Dublin-time incident notes.
  const available = await computeAvailableSlots(db, event, date)

  return NextResponse.json({ success: true, data: { date, slots: available } })
}
