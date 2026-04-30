import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { swapStatusSchema , MANAGER_ROLES} from '@/lib/schemas'

const SwapReviewSchema = z.object({
  status: swapStatusSchema,
  review_note: z.string().max(2000).nullable().optional(),
})

// PUT /api/schedule/swaps/:id — Approve/reject a swap request
export async function PUT(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, SwapReviewSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const db = createServerClient()

  // Fetch the swap request
  const { data: swap } = await db.from('shift_swap_requests')
    .select('*, requester_shift:shifts!requester_shift_id(*), target_shift:shifts!target_shift_id(*)')
    .eq('id', params.id)
    .single()

  if (!swap) return NextResponse.json({ success: false, error: 'Swap request not found' }, { status: 404 })

  // Only managers/owners/head coaches can approve/reject
  // Staff can cancel their own requests
  if (body.status === 'cancelled' && swap.requester_id === user.id) {
    // Staff cancelling their own request
  } else if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const updates = {
    status: body.status,
    review_note: body.review_note || null,
  }

  if (['approved', 'rejected'].includes(body.status)) {
    updates.reviewed_by = user.id
    updates.reviewed_at = new Date().toISOString()
  }

  // If approved, actually swap the shifts
  if (body.status === 'approved' && swap.target_shift_id) {
    // Swap the profile_ids on both shifts
    await db.from('shifts')
      .update({ profile_id: swap.target_shift.profile_id, status: 'swapped' })
      .eq('id', swap.requester_shift_id)

    await db.from('shifts')
      .update({ profile_id: swap.requester_shift.profile_id, status: 'swapped' })
      .eq('id', swap.target_shift_id)
  } else if (body.status === 'approved' && !swap.target_shift_id) {
    // Just dropping the shift — cancel it
    await db.from('shifts')
      .update({ status: 'cancelled' })
      .eq('id', swap.requester_shift_id)
  }

  const { data, error } = await db.from('shift_swap_requests')
    .update(updates)
    .eq('id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}
