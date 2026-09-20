import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds, hasRoleAtLocation } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { timeOffStatusSchema, MANAGER_ROLES } from '@/lib/schemas'
import { notifyUsersOnce } from '@/lib/push-dedup'
import { dublinTodayStr } from '@/lib/dublin-time'
import {
  canDecideTimeOff, decidingLocationIds, getProfileLocationIds, getEmploymentType, ensureHolidayAllowanceRow, findLeaveClashes,
} from '@/lib/time-off-leave'
import { isExpiredPendingRequest, isTimeOffTypeAllowedFor } from '@shared/time-off'

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

  const isSelf = user.id === existing.profile_id
  const isMaster = user.profileRole === 'master'

  // LEAVE.2 — leave covers the person, so the studios that may act on it are
  // the one it was filed at AND every studio the requester belongs to.
  // Unreadable memberships fail closed to "filed-at only" for authority.
  const { ids: requesterLocations, error: requesterLocError } = await getProfileLocationIds(db, existing.profile_id)
  if (requesterLocError) {
    return NextResponse.json({ success: false, error: requesterLocError.message }, { status: 500 })
  }
  const actingLocations = [...new Set([existing.location_id, ...requesterLocations].filter(Boolean))]

  // SCHEDROLES.1 — manager AT A STUDIO THE REQUEST BELONGS TO
  // (hasRoleAtLocation), not `user.role` (the ACTIVE studio's role).
  const isManager = isMaster || actingLocations.some((id) => hasRoleAtLocation(user, id, MANAGER_ROLES))
  const userLocationIds = getUserLocationIds(user)
  const atLocation = isMaster || actingLocations.some((id) => userLocationIds.includes(id))

  // ROSTER-FIX.2 — a manager acts only on their own locations (404 so a
  // cross-tenant id looks missing); a requester acts only on their own
  // pending request, and only to cancel; nobody decides their own leave.
  if (!isSelf && (!isManager || !atLocation)) {
    return NextResponse.json({ success: false, error: 'Request not found' }, { status: 404 })
  }
  if (isSelf && (status === 'approved' || status === 'rejected')) {
    return NextResponse.json({ success: false, error: 'You cannot decide your own time-off request' }, { status: 403 })
  }
  if (isSelf && !isManager && (status !== 'cancelled' || existing.status !== 'pending')) {
    return NextResponse.json({ success: false, error: 'You can only cancel your own pending requests' }, { status: 403 })
  }

  const updates = { status, updated_at: new Date().toISOString() }
  const today = dublinTodayStr()

  // If approving or rejecting, record who did it
  if (status === 'approved' || status === 'rejected') {
    // APPROVALS-PERCAT.1 — permission is the only gate for the decision.
    // LEAVE.2 — held at any studio the request belongs to (see above).
    if (!canDecideTimeOff(user, existing.location_id, requesterLocations)) {
      return NextResponse.json({ success: false, error: 'You do not have permission to approve or reject time-off requests.' }, { status: 403 })
    }
    updates.reviewed_by = user.id
    updates.reviewed_at = new Date().toISOString()
    if (review_note) updates.review_note = review_note
  }

  if (status === 'approved') {
    // LEAVE.2 — a pending request whose last day has passed has expired
    // (derived, see isExpiredPendingRequest). Approving it now would book
    // leave nobody can still plan around; record it afresh instead.
    if (isExpiredPendingRequest(existing, today)) {
      return NextResponse.json({
        success: false,
        error: `This request expired on ${existing.end_date}. Record the leave again if it still needs approving.`,
      }, { status: 409 })
    }

    // LEAVE.3 — contractors may only be unavailable; approving a holiday for
    // one is what created a 20-day allowance for a contractor.
    const { employmentType, error: employmentError } = await getEmploymentType(db, existing.profile_id)
    if (employmentError) {
      return NextResponse.json({ success: false, error: employmentError.message }, { status: 500 })
    }
    if (!isTimeOffTypeAllowedFor(employmentType, existing.type)) {
      return NextResponse.json({
        success: false,
        error: 'Contractors can only be marked Unavailable. Decline this request and ask them to file it as Unavailable.',
      }, { status: 400 })
    }

    // LEAVE.4 — seed this year's allowance from the contract entitlement
    // before the trigger (mig 011) would create it at a flat 20 days.
    if (existing.type === 'holiday' && existing.status !== 'approved') {
      const { error: seedError } = await ensureHolidayAllowanceRow(db, existing.profile_id, Number(String(existing.start_date).slice(0, 4)))
      if (seedError) {
        return NextResponse.json({ success: false, error: seedError.message }, { status: 500 })
      }
    }
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
        // Mobile week-preselects the schedule tab on the request's first day.
        start_date: existing.start_date,
      },
    }).catch(err => {
      // Best-effort — never block the API response on notify.
      console.error('[time-off] notify failed', err)
    })
  }

  // LEAVE.1 — approving leave does not touch the roster. Hand back the live
  // shifts the person is still on during it, so the approver can see the
  // clash and choose "Unassign them" (POST ./unassign-clashes). Advisory: a
  // failed lookup never undoes the approval.
  if (status === 'approved') {
    // ORGSCOPE.1 — bounded by the organisation(s) of the studios this approver
    // decides from, not by where the leave was filed.
    const { clashes, error: clashError } = await findLeaveClashes(db, data, today, {
      scopeLocationIds: decidingLocationIds(user, existing.location_id, requesterLocations),
    })
    if (clashError) {
      console.error('[time-off] clash lookup failed', clashError.message)
      return NextResponse.json({ success: true, data, clashes: [], clashes_error: 'Could not check the roster for clashes' })
    }
    return NextResponse.json({ success: true, data, clashes })
  }

  return NextResponse.json({ success: true, data })
}
