// POST /api/bookings/[id]/skip-reminder — the /bookings bell: skip (or
// re-enable) this booking's reminders (mig 075). C134 WEBBOOKINGWRITES.1: this
// was a browser-client write judged by RLS on the PHONE `bookings` key; it is
// judged here on the WEB `bookings` key at the booking's studio
// (src/lib/booking-web-writes.js).
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { validateBody } from '@/lib/validate'
import { bookingsWriteForbiddenAnywhere, loadBookingForWebWrite } from '@/lib/booking-web-writes'

const SkipSchema = z.object({ skip_reminder: z.boolean() })

// The studio is the BOOKING's, so withAuth only signs the caller in; the coarse
// 403, the body check and the booking's own gate run here, in this order.
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  const coarse = bookingsWriteForbiddenAnywhere(user)
  if (coarse) return coarse

  const validation = await validateBody(request, SkipSchema)
  if (!validation.ok) return validation.response
  const { skip_reminder } = validation.data

  const { response, booking } = await loadBookingForWebWrite(db, user, params?.id)
  if (response) return response

  const { data, error } = await db.from('bookings')
    .update({ skip_reminder })
    .eq('id', booking.id)
    .select('id, skip_reminder')
  if (error) {
    return NextResponse.json({ success: false, error: 'Could not change the reminder setting. Try again.' }, { status: 500 })
  }
  if (!data?.length) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  return NextResponse.json({ success: true, data: data[0] })
})
