import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'

// GET /api/schedule/swaps?location_id=xxx&status=pending
export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  const status = searchParams.get('status')
  const db = createServerClient()

  let query = db.from('shift_swap_requests')
    .select(`
      *,
      requester_shift:shifts!requester_shift_id(*, shift_templates(*), profiles!profile_id(id, full_name)),
      target_shift:shifts!target_shift_id(*, shift_templates(*), profiles!profile_id(id, full_name)),
      requester:profiles!requester_id(id, full_name, avatar_url),
      target:profiles!target_id(id, full_name, avatar_url),
      reviewer:profiles!reviewed_by(id, full_name)
    `)
    .order('created_at', { ascending: false })

  if (locationId) query = query.eq('location_id', locationId)
  if (status) query = query.eq('status', status)

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}

// POST /api/schedule/swaps — Create a swap request
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const db = createServerClient()

  if (!body.requester_shift_id) {
    return NextResponse.json({ success: false, error: 'requester_shift_id is required' }, { status: 400 })
  }

  // Verify the requester owns this shift
  const { data: shift } = await db.from('shifts')
    .select('*')
    .eq('id', body.requester_shift_id)
    .eq('profile_id', user.id)
    .single()

  if (!shift) {
    return NextResponse.json({ success: false, error: 'Shift not found or not yours' }, { status: 404 })
  }

  const { data, error } = await db.from('shift_swap_requests').insert({
    location_id: shift.location_id,
    requester_shift_id: body.requester_shift_id,
    requester_id: user.id,
    target_shift_id: body.target_shift_id || null,
    target_id: body.target_id || null,
    reason: body.reason || null,
    status: 'pending',
  }).select().single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data }, { status: 201 })
}
