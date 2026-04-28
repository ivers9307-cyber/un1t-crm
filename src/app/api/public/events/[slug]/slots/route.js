import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

// GET /api/public/events/:slug/slots?date=2026-04-28
// Returns available time slots for a given date
export async function GET(request, { params }) {
  const db = createServerClient()
  const { searchParams } = new URL(request.url)
  const date = searchParams.get('date')

  if (!date) {
    return NextResponse.json({ success: false, error: 'date parameter is required (YYYY-MM-DD)' }, { status: 400 })
  }

  // Get event type
  const { data: event, error: eventErr } = await db.from('event_types')
    .select('id, duration_minutes, availability, buffer_minutes, max_advance_days')
    .eq('slug', params.slug)
    .eq('active', true)
    .single()

  if (eventErr || !event) {
    return NextResponse.json({ success: false, error: 'Event not found' }, { status: 404 })
  }

  // Check date is within allowed range
  const requestedDate = new Date(date + 'T00:00:00')
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const maxDate = new Date(today)
  maxDate.setDate(maxDate.getDate() + event.max_advance_days)

  if (requestedDate < today) {
    return NextResponse.json({ success: true, data: { date, slots: [] } })
  }
  if (requestedDate > maxDate) {
    return NextResponse.json({ success: true, data: { date, slots: [] } })
  }

  // Get day of week
  const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
  const dayName = dayNames[requestedDate.getDay()]
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

  const available = slots.filter(slot => {
    // Check not booked
    const isBooked = bookedSlots.some(b => slot.start < b.end && slot.end > b.start)
    if (isBooked) return false

    // Check not blocked
    const isBlocked = blocked.some(b => slot.start < b.end && slot.end > b.start)
    if (isBlocked) return false

    // If date is today, filter out past times
    const now = new Date()
    if (requestedDate.toDateString() === now.toDateString()) {
      const nowMinutes = now.getHours() * 60 + now.getMinutes()
      const [slotH, slotM] = slot.start.split(':').map(Number)
      if (slotH * 60 + slotM <= nowMinutes) return false
    }

    return true
  })

  return NextResponse.json({ success: true, data: { date, slots: available } })
}
