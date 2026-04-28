import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { requireApiKey } from '@/lib/api-auth'

// PUT /api/bookings/:id — Update booking (status changes, notes)
export async function PUT(request, { params }) {
  const authError = requireApiKey(request)
  if (authError) return authError

  const body = await request.json()
  const db = createServerClient()

  const allowed = ['status', 'notes', 'booking_date', 'start_time', 'end_time']
  const updates = {}
  for (const key of allowed) {
    if (body[key] !== undefined) updates[key] = body[key]
  }

  const { data, error } = await db.from('bookings').update(updates).eq('id', params.id).select().single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return NextResponse.json({ success: true, data })
}
