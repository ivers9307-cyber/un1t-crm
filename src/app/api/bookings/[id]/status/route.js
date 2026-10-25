// POST /api/bookings/[id]/status — the /bookings status pill's non-cancel
// changes (confirmed, completed, no_show). C134 WEBBOOKINGWRITES.1: this was
// a browser-client write judged by RLS on the PHONE `bookings` key; it is
// judged here on the WEB `bookings` key at the booking's studio
// (src/lib/booking-web-writes.js). Cancelling is POST /api/bookings/[id]/cancel
// (it notifies the customer), and a cancelled booking is not re-opened here:
// cancel is one-way, as the cancel dialog says. The status write is a
// compare-and-swap on the status it was judged against.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { bookingsWriteForbiddenAnywhere, loadBookingForWebWrite } from '@/lib/booking-web-writes'

const StatusSchema = z.object({
  status: z.enum(['confirmed', 'completed', 'no_show'], {
    error: "status may be 'confirmed', 'completed' or 'no_show'; cancel a booking with Cancel booking",
  }),
})

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const coarse = bookingsWriteForbiddenAnywhere(user)
  if (coarse) return coarse

  const validation = await validateBody(request, StatusSchema)
  if (!validation.ok) return validation.response
  const { status } = validation.data

  const db = createServerClient()
  const { response, booking } = await loadBookingForWebWrite(db, user, params.id)
  if (response) return response

  if (booking.status === 'cancelled') {
    return NextResponse.json({
      success: false,
      error: 'This booking is cancelled. Cancelling is one-way: make a new booking instead.',
    }, { status: 409 })
  }

  const { data, error } = await db.from('bookings')
    .update({ status })
    .eq('id', booking.id)
    .eq('status', booking.status)
    .select('id, status')
  if (error) {
    return NextResponse.json({ success: false, error: 'Could not change the booking status. Try again.' }, { status: 500 })
  }
  if (!data?.length) {
    return NextResponse.json({
      success: false,
      error: 'The booking changed while you were looking at it. Reload the page and try again.',
    }, { status: 409 })
  }
  return NextResponse.json({ success: true, data: data[0] })
}
