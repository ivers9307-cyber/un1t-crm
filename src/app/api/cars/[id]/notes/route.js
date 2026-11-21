// /api/cars/[id]/notes
//
// GET   — list notes (newest first)
// POST  — add a manual note. Body: { content }.
//
// System notes (kind='system') are inserted by other server code
// like /issue-deposit-link — they're not creatable through this
// route (the schema would allow it but exposing 'kind' to clients
// would let an operator forge a system entry).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { validateBody } from '@/lib/validate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function loadCar(db, carId) {
  const { data } = await db
    .from('cars')
    .select('id, location_id')
    .eq('id', carId)
    .single()
  return data
}

// withAuth only signs the caller in; car_processing somewhere, the car's
// studio (404) and car_processing there run by hand, in their old order.
export const GET = withAuth({ permission: null, location: false }, async ({ user, db, params }) => {
  if (!hasPermissionAtAnyLocation(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }

  const car = await loadCar(db, params?.id)
  if (!car) return NextResponse.json({ success: false, error: 'Car not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, car.location_id)
  if (guard) return guard
  // ROLESWEEP.1b — judged at the car's location, not the caller's active studio.
  if (!hasPermissionForLocation(user, car.location_id, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }

  const { data, error } = await db
    .from('car_notes')
    .select('id, content, kind, created_at, created_by, profiles:created_by(full_name)')
    .eq('car_id', car.id)
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) {
    logError('car-notes', 'notes read failed', { carId: car.id, err: error })
    return NextResponse.json({ success: false, error: 'Could not load the notes.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, notes: data || [] })
})

const PostBody = z.object({
  content: z.string().min(1).max(5000),
})

export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  if (!hasPermissionAtAnyLocation(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }

  const v = await validateBody(request, PostBody)
  if (!v.ok) return v.response

  const car = await loadCar(db, params?.id)
  if (!car) return NextResponse.json({ success: false, error: 'Car not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, car.location_id)
  if (guard) return guard
  // ROLESWEEP.1b — judged at the car's location, not the caller's active studio.
  if (!hasPermissionForLocation(user, car.location_id, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }

  const { data, error } = await db
    .from('car_notes')
    .insert({
      car_id: car.id,
      location_id: car.location_id,
      content: v.data.content.trim(),
      kind: 'manual',
      created_by: user.id,
    })
    .select('id, content, kind, created_at, created_by, profiles:created_by(full_name)')
    .single()

  if (error) {
    logError('car-notes', 'note insert failed', { carId: car.id, err: error })
    return NextResponse.json({ success: false, error: 'Could not save the note.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, note: data })
})
