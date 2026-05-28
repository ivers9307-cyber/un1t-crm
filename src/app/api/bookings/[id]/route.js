import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { authenticateApiKey, orgLocationIds } from '@/lib/api-auth'
import { validateBody } from '@/lib/validate'
import { isoDate, timeOfDay } from '@/lib/schemas'

const BookingUpdateSchema = z.object({
  status: z.enum(['pending', 'confirmed', 'completed', 'cancelled', 'no_show']).optional(),
  notes: z.string().max(5000).nullable().optional(),
  booking_date: isoDate.optional(),
  start_time: timeOfDay.optional(),
  end_time: timeOfDay.optional(),
})

// PUT /api/bookings/:id — Update booking (status changes, notes)
export async function PUT(request, props) {
  const params = await props.params;
  const auth = await authenticateApiKey(request)
  if (!auth.ok) return auth.response

  const validation = await validateBody(request, BookingUpdateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const db = createServerClient()

  // APIKEYS.3 — per-org key may only update a booking whose location is
  // in its org. 404 to avoid confirming the id. Legacy/cookie unchanged.
  if (auth.orgId) {
    const locIds = await orgLocationIds(db, auth.orgId)
    const { data: existing } = await db.from('bookings').select('location_id').eq('id', params.id).maybeSingle()
    if (!existing || !locIds.includes(existing.location_id)) {
      return NextResponse.json({ success: false, error: 'not_found' }, { status: 404 })
    }
  }

  const updates = { ...body }

  const { data, error } = await db.from('bookings').update(updates).eq('id', params.id).select().single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return NextResponse.json({ success: true, data })
}
