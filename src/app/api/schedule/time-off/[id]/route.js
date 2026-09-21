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
import { isExpiredPendingRequest, isTimeOffTypeAllowedFor, timeOffLeaveLabel } from '@shared/time-off'
import {
  selfCancelMode, isOpenCancelAsk, isOwnerForLeave, leaveActingLocationIds,
  resolveLeaveCancelDeciderIds, cancelAskEventKey, leaveRangeText,
} from '@/lib/time-off-cancel'

const TimeOffReviewSchema = z.object({
  status: timeOffStatusSchema,
  review_note: z.string().max(2000).nullable().optional(),
  // LEAVECANCEL.1 — the requester's optional reason when `cancelled` on their
  // own approved leave becomes an ask. Ignored on every other path.
  cancel_request_note: z.string().max(2000).nullable().optional(),
})

const REQUEST_WITH_PEOPLE = `
      *,
      profiles!profile_id(id, full_name, avatar_url, role),
      reviewer:profiles!reviewed_by(id, full_name)
    `

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
  const actingLocations = leaveActingLocationIds(existing, requesterLocations)

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
    // LEAVECANCEL.1 — unchanged and out of scope: a plain coach's own APPROVED
    // leave stays refused here. Only a caller this gate lets through (manager
    // tier at a studio the request belongs to) reaches the ask below.
    return NextResponse.json({ success: false, error: 'You can only cancel your own pending requests' }, { status: 403 })
  }
  // LEAVECANCEL.1 — the only thing anyone may do to their OWN request is cancel
  // it. approved/rejected are refused above; `pending` was the value left, and
  // for a manager it was a side door: approved -> pending -> cancelled takes
  // the leave out of force with no owner asked (and no allowance refund).
  if (isSelf && status !== 'cancelled') {
    return NextResponse.json({ success: false, error: 'You can only cancel your own requests' }, { status: 403 })
  }

  const today = dublinTodayStr()

  // LEAVECANCEL.1 — the owner's rule: a manager cancelling their OWN APPROVED
  // leave needs an owner's approval. So this PUT does not cancel it: it
  // records the ask (mig 624 columns) and the leave STAYS APPROVED, in force
  // for every reader, until POST ./cancel-request decides. A master is
  // 'direct' and falls through to the plain cancel below, as before.
  if (isSelf && status === 'cancelled' && existing.status === 'approved') {
    const mode = selfCancelMode(user, existing, today, requesterLocations)
    if (mode === 'ended') {
      return NextResponse.json({
        success: false,
        error: `This leave ended on ${existing.end_date}, so there is nothing left to cancel.`,
      }, { status: 409 })
    }
    if (mode === 'ask') {
      return requestOwnLeaveCancel(db, user, existing, { today, requesterLocations, note: body.cancel_request_note })
    }
  }

  const updates = { status, updated_at: new Date().toISOString() }

  // LEAVECANCEL.1 — mig 624 ties cancel_decision='approved' to
  // status='cancelled' (a row may not claim an approved cancellation while in
  // force). Moving such a row to any other status (an approver re-approving
  // leave that was cancelled) would therefore be refused by the CHECK with a
  // constraint error. The old cancellation goes with the old status instead.
  if (status !== 'cancelled' && existing.cancel_decision === 'approved') {
    Object.assign(updates, {
      cancel_requested_at: null, cancel_requested_by: null, cancel_request_note: null,
      cancel_decided_at: null, cancel_decided_by: null, cancel_decision: null, cancel_decision_note: null,
    })
  }

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
    .select(REQUEST_WITH_PEOPLE)
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

// LEAVECANCEL.1 — record "please cancel my approved leave" and tell whoever
// can decide it. Nothing here touches `status`.
async function requestOwnLeaveCancel(db, user, existing, { today, requesterLocations, note }) {
  // Asking twice is one ask: nothing written, nobody told again.
  if (isOpenCancelAsk(existing, today)) {
    return NextResponse.json({ success: true, data: existing, cancellation: 'requested', already_requested: true })
  }

  // Someone must be able to decide it BEFORE it is recorded, or it sits in a
  // queue nobody has. Fails closed: an unreadable list is a 500, not a guess.
  const actingLocations = leaveActingLocationIds(existing, requesterLocations)
  const { ownerIds, masterIds, error: deciderError } = await resolveLeaveCancelDeciderIds(db, actingLocations, user.id)
  if (deciderError) {
    return NextResponse.json({ success: false, error: deciderError.message }, { status: 500 })
  }
  if (ownerIds.length === 0 && isOwnerForLeave(user, existing, requesterLocations)) {
    // An owner needs a DIFFERENT owner. With none, the ask is refused rather
    // than rerouted: a platform admin can cancel the leave for them through
    // this same PUT. (Whether a sole owner's ask should go to the masters'
    // queue instead is the owner's call; flagged on the PR.)
    return NextResponse.json({
      success: false,
      error: 'There is no other owner at your studios to approve this. Ask a platform admin to cancel the leave for you.',
    }, { status: 409 })
  }
  const deciderIds = ownerIds.length > 0 ? ownerIds : masterIds
  if (deciderIds.length === 0) {
    return NextResponse.json({
      success: false,
      error: 'There is no owner or platform admin who could approve this cancellation, so it was not sent.',
    }, { status: 409 })
  }

  const now = new Date().toISOString()
  const { data: rows, error } = await db.from('time_off_requests')
    .update({
      cancel_requested_at: now,
      cancel_requested_by: user.id,
      cancel_request_note: note || null,
      // A second ask after a decline starts clean.
      cancel_decided_at: null,
      cancel_decided_by: null,
      cancel_decision: null,
      cancel_decision_note: null,
      updated_at: now,
    })
    .eq('id', existing.id)
    .eq('status', 'approved')
    // Never on top of an ask that is still waiting.
    .or('cancel_requested_at.is.null,cancel_decided_at.not.is.null')
    .select(REQUEST_WITH_PEOPLE)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  // A zero-row UPDATE is not an error in PostgREST: the row moved between the
  // read and the write. Look again. An ask that is now open is the same
  // outcome the caller wanted (a double click); anything else is said plainly.
  if (!rows || rows.length === 0) {
    const { data: fresh, error: freshError } = await db.from('time_off_requests')
      .select('*')
      .eq('id', existing.id)
      .maybeSingle()
    if (!freshError && isOpenCancelAsk(fresh, today)) {
      return NextResponse.json({ success: true, data: fresh, cancellation: 'requested', already_requested: true })
    }
    return NextResponse.json({
      success: false,
      error: 'This leave changed while you were asking. Refresh to see where it stands.',
    }, { status: 409 })
  }
  const data = rows[0]

  // Event-driven, like time_off_inbound: sent when it happens, with no quiet-
  // hours gate. staff-push-hours.js gates CRON pushes, where a later tick
  // retries; there is no later tick here, so a gate would lose the notice.
  // Best-effort: a failed notice never fails the ask.
  try {
    notifyUsersOnce(db, cancelAskEventKey('time_off_cancel_ask', data), deciderIds, {
      title: 'Leave cancellation to approve',
      body: `${user.full_name || 'A manager'} has asked to cancel approved leave: ${timeOffLeaveLabel(data.type)}, ${leaveRangeText(data)}.`,
      category: 'time_off',
      emailSubject: `Leave cancellation request from ${user.full_name || 'a manager'}`,
      data: { type: 'time_off_cancel_request', request_id: data.id },
    }).catch(err => console.error('[time-off] cancel-ask notify failed', err))
  } catch (err) {
    console.error('[time-off] cancel-ask notify failed', err)
  }

  return NextResponse.json({ success: true, data, cancellation: 'requested' })
}
