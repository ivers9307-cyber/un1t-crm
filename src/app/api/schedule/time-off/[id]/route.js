import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { timeOffStatusSchema , MANAGER_ROLES} from '@/lib/schemas'
import { notifyUsersOnce } from '@/lib/push-dedup'

const TimeOffReviewSchema = z.object({
  status: timeOffStatusSchema,
  review_note: z.string().max(2000).nullable().optional(),
})

// PUT /api/schedule/time-off/:id — Approve, reject, or cancel a request
export async function PUT(request, props) {
  const params = await props.params;
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

  // Notify the requester on a manager decision (approval / rejection).
  // Cancellations by the requester themselves don't need a push back to
  // themselves, and a manager-cancellation is handled by the request
  // being deleted from their inbox naturally.
  if ((status === 'approved' || status === 'rejected') && existing.profile_id !== user.id) {
    const verb = status === 'approved' ? 'approved' : 'declined'
    const range = existing.start_date === existing.end_date
      ? existing.start_date
      : `${existing.start_date} – ${existing.end_date}`
    // NOTIF.9 — migrated to notifyUsers. Push first; if the
    // requester has no device tokens, they get a fallback email
    // via Postmark (category 'time_off' opts in via fallbackEmail:
    // true in notifications-registry).
    notifyUsersOnce(db, `time_off_decision:${existing.id}:${status}`, [existing.profile_id], {
      title: `Time off ${verb}`,
      body: `Your ${existing.type} request for ${range} was ${verb}${review_note ? ` — “${review_note}”` : ''}.`,
      category: 'time_off',
      emailSubject: `Time-off request ${verb}`,
      data: {
        type: 'time_off_decision',
        request_id: existing.id,
        status,
      },
    }).catch(err => {
      // Best-effort — never block the API response on notify.
      console.error('[time-off] notify failed', err)
    })
  }

  return NextResponse.json({ success: true, data })
}
