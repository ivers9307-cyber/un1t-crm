import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { timeOffStatusSchema , MANAGER_ROLES} from '@/lib/schemas'

const TimeOffReviewSchema = z.object({
  status: timeOffStatusSchema,
  review_note: z.string().max(2000).nullable().optional(),
})

// PUT /api/schedule/time-off/:id — Approve, reject, or cancel a request
export async function PUT(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, TimeOffReviewSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const db = createServerClient()

  // Get the existing request
  const { data: existing } = await db.from('time_off_requests')
    .select('*')
    .eq('id', params.id)
    .single()

  if (!existing) {
    return NextResponse.json({ success: false, error: 'Request not found' }, { status: 404 })
  }

  const { status, review_note } = body

  // Staff can only cancel their own pending requests
  if (user.id === existing.profile_id) {
    if (status !== 'cancelled' || existing.status !== 'pending') {
      if (!MANAGER_ROLES.includes(user.role)) {
        return NextResponse.json({ success: false, error: 'You can only cancel your own pending requests' }, { status: 403 })
      }
    }
  } else if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const updates = { status, updated_at: new Date().toISOString() }

  // If approving or rejecting, record who did it
  if (status === 'approved' || status === 'rejected') {
    if (!MANAGER_ROLES.includes(user.role)) {
      return NextResponse.json({ success: false, error: 'Only managers can approve or reject requests' }, { status: 403 })
    }
    updates.reviewed_by = user.id
    updates.reviewed_at = new Date().toISOString()
    if (review_note) updates.review_note = review_note
  }

  const { data, error } = await db.from('time_off_requests')
    .update(updates)
    .eq('id', params.id)
    .select(`
      *,
      profiles!profile_id(id, full_name, avatar_url, role),
      reviewer:profiles!reviewed_by(id, full_name)
    `)
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}
