import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess , getUserLocationIds} from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'
import { sendPushOnce, sendPushToRolesAtLocationOnce } from '@/lib/push-dedup'
import { swapShiftShape } from '@/lib/roster-read'

const SwapCreateSchema = z.object({
  requester_shift_id: uuidLike,
  target_shift_id: uuidLike.nullable().optional(),
  target_id: uuidLike.nullable().optional(),
  reason: z.string().max(2000).nullable().optional(),
})

// RETIRE-SHIFTS-MIRROR.5c — swap rows now FK shift_assignments(id), not the
// legacy shifts(id). The embedded assignment (+ its block + template) is
// flattened back to the legacy shift shape via swapShiftShape() so the GET
// response stays byte-identical for every consumer (web approvals,
// SwapRequestsManager, web + mobile dashboards).
const SWAP_SHIFT_EMBED = `
  id, profile_id, status, notes, start_time_override, end_time_override,
  shift_blocks!block_id (
    block_date, start_time, end_time,
    shift_templates ( name, start_time, end_time, role_label )
  ),
  profiles!profile_id ( id, full_name )
`

// GET /api/schedule/swaps?location_id=xxx&status=pending
export async function GET(request) {
  const user = await getCurrentUser()
  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const status = searchParams.get('status')
  const forMe = searchParams.get('for_me') === '1'
  const open = searchParams.get('open') === '1'
  const db = createServerClient()

  let query = db.from('shift_swap_requests')
    .select(`
      *,
      requester_shift:shift_assignments!requester_shift_id(${SWAP_SHIFT_EMBED}),
      target_shift:shift_assignments!target_shift_id(${SWAP_SHIFT_EMBED}),
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

  // CT-P3 actionable lists for coaches. for_me = swaps targeted at / claimed
  // by the caller (needs their accept/decline or shows "awaiting manager").
  // open = unclaimed pool the caller may take (not their own). Names ride
  // along via the service-role profiles embed (works for web + mobile, which
  // can't embed profiles from its authenticated client).
  if (forMe || open) {
    if (!user) return NextResponse.json({ success: true, data: [] })
    if (forMe) {
      query = query.eq('target_id', user.id).in('status', ['pending', 'awaiting_approval'])
    } else if (open) {
      query = query.is('target_id', null).eq('status', 'pending').neq('requester_id', user.id)
    }
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  // Flatten the embedded assignment back to the legacy shift shape the
  // consumers read (requester_shift.shift_date / .shift_templates / overrides).
  const shaped = (data || []).map((row) => ({
    ...row,
    requester_shift: swapShiftShape(row.requester_shift),
    target_shift: swapShiftShape(row.target_shift),
  }))
  return NextResponse.json({ success: true, data: shaped })
}

// POST /api/schedule/swaps — Create a swap request
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, SwapCreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const db = createServerClient()

  // Verify the requester owns this assignment (requester_shift_id is now a
  // shift_assignments.id — RETIRE-SHIFTS-MIRROR.5c). Pull location_id off
  // the assignment's block.
  const { data: assignment } = await db.from('shift_assignments')
    .select('id, profile_id, shift_blocks!block_id(location_id)')
    .eq('id', body.requester_shift_id)
    .eq('profile_id', user.id)
    .single()

  if (!assignment) {
    return NextResponse.json({ success: false, error: 'Shift not found or not yours' }, { status: 404 })
  }
  const swapLocationId = assignment.shift_blocks?.location_id
  if (!swapLocationId) {
    return NextResponse.json({ success: false, error: 'Shift has no location' }, { status: 400 })
  }

  const { data, error } = await db.from('shift_swap_requests').insert({
    location_id: swapLocationId,
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
    sendPushOnce(db, `swap_inbound:${data.id}`, [body.target_id], {
      title: 'New shift swap request',
      body: `${user.full_name} wants to swap a shift with you. Tap to review.`,
      category: 'swap',
      data: { type: 'swap_inbound', swap_id: data.id },
    }).catch(err => console.error('[swaps] push to target failed', err))
  } else {
    sendPushToRolesAtLocationOnce(db, `swap_open:${data.id}`, swapLocationId, MANAGER_ROLES, {
      title: 'Open swap request',
      body: `${user.full_name} posted a shift for swap. Tap to review.`,
      category: 'swap',
      data: { type: 'swap_open', swap_id: data.id },
    }).catch(err => console.error('[swaps] push to managers failed', err))
  }

  return NextResponse.json({ success: true, data }, { status: 201 })
}
