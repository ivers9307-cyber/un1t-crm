import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess , getUserLocationIds} from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'
import { sendPush, sendPushToRolesAtLocation } from '@/lib/push'

const SwapCreateSchema = z.object({
  requester_shift_id: uuidLike,
  target_shift_id: uuidLike.nullable().optional(),
  target_id: uuidLike.nullable().optional(),
  reason: z.string().max(2000).nullable().optional(),
})

// GET /api/schedule/swaps?location_id=xxx&status=pending
export async function GET(request) {
  const user = await getCurrentUser()
  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

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

  if (locationId) {
    query = query.eq('location_id', locationId)
  } else {
    const userLocationIds = getUserLocationIds(user)
    if (userLocationIds.length === 0) return NextResponse.json({ success: true, data: [] })
    query = query.in('location_id', userLocationIds)
  }
  if (status) query = query.eq('status', status)

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}

// POST /api/schedule/swaps — Create a swap request
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, SwapCreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const db = createServerClient()

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

  // Notify the targeted teammate if one was specified, otherwise alert
  // managers at the location that an open swap is up for grabs. Either
  // way, push delivery is best-effort.
  if (body.target_id) {
    sendPush([body.target_id], {
      title: 'New shift swap request',
      body: `${user.full_name} wants to swap a shift with you. Tap to review.`,
      category: 'swap',
      data: { type: 'swap_inbound', swap_id: data.id },
    }).catch(err => console.error('[swaps] push to target failed', err))
  } else {
    sendPushToRolesAtLocation(shift.location_id, MANAGER_ROLES, {
      title: 'Open swap request',
      body: `${user.full_name} posted a shift for swap. Tap to review.`,
      category: 'swap',
      data: { type: 'swap_open', swap_id: data.id },
    }).catch(err => console.error('[swaps] push to managers failed', err))
  }

  return NextResponse.json({ success: true, data }, { status: 201 })
}
