// POST /api/bookings/outcomes — BOOKINGOUTCOME.1, the "Mark all as showed"
// action on /bookings?filter=needs_outcome.
//
//   body   { booking_ids: uuid[] (1..200), status: 'completed' | 'no_show' }
//   200    { success, data: { updated: [id], skipped: [{ id, reason }] } }
//
// Each booking is judged with the single route's rule
// (POST /api/bookings/[id]/status via src/lib/booking-web-writes.js): the web
// `bookings` key at SOME studio first (403 before any read), then, per
// booking, membership at its studio (its location_id, else its booking
// type's; a miss reads as not_found, ids are not enumerable) and the web key
// there (forbidden). Only a booking still 'confirmed' whose END has passed
// (booking_date + end_time, a wall clock in ITS studio's zone) is accepted.
// The write is one compare-and-swap on status = 'confirmed'; an accepted
// booking the write did not touch changed underneath and is skipped as
// 'changed'. Cancelling is not offered: it notifies the customer and has its
// own route.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { getLocationZones } from '@/lib/location-time'
import { bookingsWriteForbiddenAnywhere, judgeBookingForWebWrite } from '@/lib/booking-web-writes'
import { judgeOutcomeTarget } from '@/lib/booking-outcomes'
import { logError } from '@/lib/log'

const MAX_OUTCOME_IDS = 200

const OutcomesSchema = z.object({
  booking_ids: z.array(uuidLike).min(1).max(MAX_OUTCOME_IDS),
  status: z.enum(['completed', 'no_show'], {
    error: "status may be 'completed' or 'no_show'",
  }),
})

const fail = (error, status = 500) => NextResponse.json({ success: false, error }, { status })

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return fail('Unauthorized', 401)
  const coarse = bookingsWriteForbiddenAnywhere(user)
  if (coarse) return coarse

  const validation = await validateBody(request, OutcomesSchema)
  if (!validation.ok) return validation.response
  const { status } = validation.data
  const ids = [...new Set(validation.data.booking_ids)]

  const db = createServerClient()
  // At most 200 ids: one read, under the 1,000-row cap.
  const { data: rows, error: readError } = await db.from('bookings')
    .select('id, status, location_id, booking_date, start_time, end_time, event_types(location_id)')
    .in('id', ids)
  if (readError) {
    logError('bookings-outcomes', 'bookings read failed', { code: readError.code })
    return fail('Could not read the bookings. Try again.')
  }
  const byId = new Map((rows || []).map((r) => [r.id, r]))

  // Membership and permission first, so a studio the user cannot see never
  // has its zone read.
  const skipped = []
  const judged = []
  for (const id of ids) {
    const booking = byId.get(id)
    const verdict = judgeBookingForWebWrite(user, booking)
    if (verdict.refused) skipped.push({ id, reason: verdict.refused })
    else judged.push({ id, booking, locationId: verdict.locationId })
  }

  let zones
  try {
    zones = await getLocationZones(db, judged.map((j) => j.locationId))
  } catch (err) {
    logError('bookings-outcomes', 'studio zone read failed', { message: err?.message })
    return fail('Could not read the studio time zone. Try again.')
  }

  const nowMs = Date.now()
  const accepted = []
  for (const { id, booking, locationId } of judged) {
    const reason = judgeOutcomeTarget(booking, zones.get(locationId), nowMs)
    if (reason) skipped.push({ id, reason })
    else accepted.push(id)
  }
  // Keep the answer in the order the ids were sent.
  const order = new Map(ids.map((id, i) => [id, i]))
  skipped.sort((a, b) => order.get(a.id) - order.get(b.id))

  if (!accepted.length) {
    return NextResponse.json({ success: true, data: { updated: [], skipped } })
  }

  const { data: written, error: writeError } = await db.from('bookings')
    .update({ status })
    .in('id', accepted)
    .eq('status', 'confirmed')
    .select('id')
  if (writeError) {
    logError('bookings-outcomes', 'bookings write failed', { code: writeError.code, count: accepted.length })
    return fail('Could not save the outcomes. Reload the page to see what was saved, then try again.')
  }
  const done = new Set((written || []).map((r) => r.id))
  const updated = accepted.filter((id) => done.has(id))
  for (const id of accepted) if (!done.has(id)) skipped.push({ id, reason: 'changed' })

  return NextResponse.json({ success: true, data: { updated, skipped } })
}
