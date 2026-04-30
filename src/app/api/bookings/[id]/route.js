import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { requireApiKey } from '@/lib/api-auth'
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
export async function PUT(request, { params }) {
  const authError = requireApiKey(request)
  if (authError) return authError

  const validation = await validateBody(request, BookingUpdateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const db = createServerClient()

  const updates = { ...body }

  const { data, error } = await db.from('bookings').update(updates).eq('id', params.id).select().single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return NextResponse.json({ success: true, data })
}
