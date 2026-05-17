import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { dublinTodayStr, dublinNowMinutes, addDaysISO } from '@/lib/dublin-time'

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

  // Range checks in Dublin time (string comparison on YYYY-MM-DD
  // is lexically equivalent to date comparison).
  const todayStr = dublinTodayStr()
  const maxDateStr = addDaysISO(todayStr, event.max_advance_days)

  if (date < todayStr) {
    return NextResponse.json({ success: true, data: { date, slots: [] } })
  }
  if (date > maxDateStr) {
    return NextResponse.json({ success: true, data: { date, slots: [] } })
  }

  // Day of week — parse the date string as UTC midnight and use
  // getUTCDay() so the result is stable wherever this runs. The
  // input date is a calendar date with no TZ; we just need its
  // weekday.
  const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
  const dayName = dayNames[new Date(date + 'T00:00:00Z').getUTCDay()]
  const dayAvailability = event.availability[dayName]

  if (!dayAvailability) {
    return NextResponse.json({ success: true, data: { date, slots: [] } })
  }

  // Generate time slots
  const slots = []
  const [startH, startM] = dayAvailability.start.split(':').map(Number)
  const [endH, endM] = dayAvailability.end.split(':').map(Number)
  const startMinutes = startH * 60 + startM
  const endMinutes = endH * 60 + endM
  const step = event.duration_minutes + event.buffer_minutes

  for (let m = startMinutes; m + event.duration_minutes <= endMinutes; m += step) {
    const slotStart = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
    const slotEndM = m + event.duration_minutes
    const slotEnd = `${String(Math.floor(slotEndM / 60)).padStart(2, '0')}:${String(slotEndM % 60).padStart(2, '0')}`
    slots.push({ start: slotStart, end: slotEnd })
  }

  // Remove slots that are already booked
  const { data: existingBookings } = await db.from('bookings')
    .select('start_time, end_time')
    .eq('event_type_id', event.id)
    .eq('booking_date', date)
    .in('status', ['confirmed', 'completed'])

  // Remove slots blocked by existing bookings
  const { data: blockedTimes } = await db.from('blocked_times')
    .select('start_time, end_time')
    .eq('event_type_id', event.id)
    .eq('blocked_date', date)

  const bookedSlots = (existingBookings || []).map(b => ({
    start: b.start_time.slice(0, 5),
    end: b.end_time.slice(0, 5),
  }))

  const blocked = (blockedTimes || []).map(b => ({
    start: b.start_time ? b.start_time.slice(0, 5) : '00:00',
    end: b.end_time ? b.end_time.slice(0, 5) : '23:59',
  }))

  // Compute the past-time cutoff once if we're filtering today —
  // dublinNowMinutes() runs an Intl format under the hood, no need
  // to repeat it for every slot.
  const isToday = date === todayStr
  const nowMinutes = isToday ? dublinNowMinutes() : -1

  const available = slots.filter(slot => {
    // Check not booked
    const isBooked = bookedSlots.some(b => slot.start < b.end && slot.end > b.start)
    if (isBooked) return false

    // Check not blocked
    const isBlocked = blocked.some(b => slot.start < b.end && slot.end > b.start)
    if (isBlocked) return false

    // If date is today, filter out past times (Dublin clock).
    if (isToday) {
      const [slotH, slotM] = slot.start.split(':').map(Number)
      if (slotH * 60 + slotM <= nowMinutes) return false
    }

    return true
  })

  return NextResponse.json({ success: true, data: { date, slots: available } })
}
