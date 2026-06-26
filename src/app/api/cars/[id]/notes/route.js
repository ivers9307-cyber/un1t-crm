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
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
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

export async function GET(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }

  const db = createServerClient()
  const car = await loadCar(db, params.id)
  if (!car) return NextResponse.json({ success: false, error: 'Car not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, car.location_id)
  if (guard) return guard

  const { data, error } = await db
    .from('car_notes')
    .select('id, content, kind, created_at, created_by, profiles:created_by(full_name)')
    .eq('car_id', params.id)
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, notes: data || [] })
}

const PostBody = z.object({
  content: z.string().min(1).max(5000),
})

export async function POST(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }

  const v = await validateBody(request, PostBody)
  if (!v.ok) return v.response

  const db = createServerClient()
  const car = await loadCar(db, params.id)
  if (!car) return NextResponse.json({ success: false, error: 'Car not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, car.location_id)
  if (guard) return guard

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

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, note: data })
}
