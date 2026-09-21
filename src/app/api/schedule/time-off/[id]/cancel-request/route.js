// LEAVECANCEL.1 — the other half of "a manager cancelling their OWN APPROVED
// leave needs an owner's approval".
//
//   PUT    ../[id] { status: 'cancelled' }   the requester ASKS (records it)
//   POST   ./cancel-request                  an owner or master DECIDES
//   DELETE ./cancel-request                  the requester WITHDRAWS
//
// Its own route, not more branches in the PUT: the PUT judges the time-off
// approval PERMISSION (canDecideTimeOff); this decision is judged on ROLE by
// the owner's explicit rule, and keeping the two gates in two files is what
// stops one being read as the other. Every rule is in src/lib/time-off-cancel.js.
//
// Until a decision lands the leave is STILL APPROVED (mig 624: the ask is
// columns, never a status). Approve is ONE UPDATE that sets status='cancelled'
// and the decision together, guarded on the row still being an open ask, so it
// cannot half-apply and two deciders cannot both land; the mig 011/616 trigger
// refunds a holiday's days on that approved -> cancelled transition.

import { NextResponse, after } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds, hasRoleAtLocation } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { MANAGER_ROLES } from '@/lib/schemas'
import { notifyUsersOnce } from '@/lib/push-dedup'
import { dublinTodayStr } from '@/lib/dublin-time'
import { getProfileLocationIds } from '@/lib/time-off-leave'
import { timeOffLeaveLabel } from '@shared/time-off'
import {
  isOpenCancelAsk, canDecideLeaveCancel, leaveActingLocationIds, cancelAskEventKey, leaveRangeText,
  CLEARED_CANCEL_ASK,
} from '@/lib/time-off-cancel'

const LeaveCancelDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  note: z.string().max(2000).nullable().optional(),
})

const REQUEST_WITH_PEOPLE = `
      *,
      profiles!profile_id(id, full_name, avatar_url, role),
      reviewer:profiles!reviewed_by(id, full_name)
    `

const NOT_FOUND = () => NextResponse.json({ success: false, error: 'Request not found' }, { status: 404 })

/**
 * Read the request and place the caller relative to it. `response` is set when
 * the caller gets no further: a missing row and a row the caller has no
 * business seeing are the SAME 404, so a cross-tenant id looks missing
 * (the PUT's ROSTER-FIX.2 pattern).
 */
async function loadForCaller(db, user, id) {
  // Primary-key read; 0 rows is a legitimate answer (404), a failed read is not.
  const { data: existing, error } = await db.from('time_off_requests')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (error) return { response: NextResponse.json({ success: false, error: error.message }, { status: 500 }) }
  if (!existing) return { response: NOT_FOUND() }

  // LEAVE.2 — the studios that may act are filed-at plus the requester's own.
  const { ids: requesterLocations, error: locError } = await getProfileLocationIds(db, existing.profile_id)
  if (locError) return { response: NextResponse.json({ success: false, error: locError.message }, { status: 500 }) }

  const isSelf = user.id === existing.profile_id
  const isMaster = user.profileRole === 'master'
  const actingLocations = leaveActingLocationIds(existing, requesterLocations)
  const mine = getUserLocationIds(user)
  // Who can SEE this request at all: the person, a master, or manager-tier
  // staff at a studio it belongs to (what GET /api/schedule/time-off shows).
  const canSee = isSelf || isMaster ||
    actingLocations.some((loc) => mine.includes(loc) && hasRoleAtLocation(user, loc, MANAGER_ROLES))
  if (!canSee) return { response: NOT_FOUND() }

  return { existing, requesterLocations, isSelf }
}

// POST /api/schedule/time-off/:id/cancel-request — approve or reject the ask
export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, LeaveCancelDecisionSchema)
  if (!validation.ok) return validation.response
  const { decision, note } = validation.data
  const db = createServerClient()

  const loaded = await loadForCaller(db, user, params.id)
  if (loaded.response) return loaded.response
  const { existing, requesterLocations, isSelf } = loaded

  if (isSelf) {
    return NextResponse.json({ success: false, error: 'You cannot decide the cancellation of your own leave' }, { status: 403 })
  }
  // Role, not permission: an owner at a studio the request belongs to, or a
  // master. A manager or head coach can see the request and still gets a 403.
  if (!canDecideLeaveCancel(user, existing, requesterLocations)) {
    return NextResponse.json({ success: false, error: 'Only an owner can approve or decline the cancellation of approved leave' }, { status: 403 })
  }

  const today = dublinTodayStr()
  if (!isOpenCancelAsk(existing, today)) {
    const ended = existing.status === 'approved' && existing.cancel_requested_at && !existing.cancel_decided_at
    return NextResponse.json({
      success: false,
      error: ended
        ? `This leave ended on ${existing.end_date}, so there is nothing left to cancel.`
        : 'There is no cancellation waiting for a decision on this leave.',
    }, { status: 409 })
  }

  const approve = decision === 'approve'
  const now = new Date().toISOString()
  const updates = {
    cancel_decided_at: now,
    cancel_decided_by: user.id,
    cancel_decision: approve ? 'approved' : 'rejected',
    cancel_decision_note: note || null,
    updated_at: now,
    // Approve cancels the leave in the SAME write. Reject never names status:
    // the leave stays approved.
    ...(approve ? { status: 'cancelled' } : {}),
  }
  const { data: rows, error } = await db.from('time_off_requests')
    .update(updates)
    .eq('id', existing.id)
    .eq('status', 'approved')
    .not('cancel_requested_at', 'is', null)
    .is('cancel_decided_at', null)
    .select(REQUEST_WITH_PEOPLE)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  // A zero-row UPDATE is not an error in PostgREST: another owner decided it,
  // or the requester withdrew it, between the read and the write.
  if (!rows || rows.length === 0) {
    return NextResponse.json({
      success: false,
      error: 'This was decided or withdrawn a moment ago. Refresh to see where it stands.',
    }, { status: 409 })
  }
  const data = rows[0]

  // A reply to the requester's own action, so it is sent when it happens.
  // Best-effort: a failed notice never fails the decision. Inside after()
  // (the SWAPNOTIFY.1 pattern): notifyUsersOnce CLAIMS before it sends, so an
  // un-awaited promise Vercel froze after the response would leave the claim
  // behind and the requester would never hear.
  const label = timeOffLeaveLabel(existing.type)
  const range = leaveRangeText(existing)
  after(() => notifyUsersOnce(db, `${cancelAskEventKey('time_off_cancel_decision', existing)}:${updates.cancel_decision}`, [existing.profile_id], {
    title: approve ? 'Leave cancellation approved' : 'Leave cancellation declined',
    body: `${approve
      ? `Your leave is cancelled: ${label}, ${range}.`
      : `Your leave stays approved: ${label}, ${range}.`}${note ? ` Note: "${note}"` : ''}`,
    category: 'time_off',
    emailSubject: approve ? 'Leave cancellation approved' : 'Leave cancellation declined',
    data: {
      type: 'time_off_decision',
      request_id: existing.id,
      // What the LEAVE now is, which is what the phone's schedule tab shows.
      status: approve ? 'cancelled' : 'approved',
      start_date: existing.start_date,
    },
  }).catch(err => console.error('[time-off] cancel-decision notify failed', err)))

  return NextResponse.json({ success: true, data, cancellation: updates.cancel_decision })
}

// DELETE /api/schedule/time-off/:id/cancel-request — the requester withdraws
export async function DELETE(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const db = createServerClient()

  const loaded = await loadForCaller(db, user, params.id)
  if (loaded.response) return loaded.response
  const { existing, isSelf } = loaded

  if (!isSelf) {
    return NextResponse.json({ success: false, error: 'Only the person who asked can withdraw the request' }, { status: 403 })
  }
  // Deliberately not isOpenCancelAsk: an ask that LAPSED with the leave may
  // still be tidied away by the person who made it.
  if (!existing.cancel_requested_at || existing.cancel_decided_at || existing.status !== 'approved') {
    return NextResponse.json({ success: false, error: 'There is no cancellation request to withdraw.' }, { status: 409 })
  }

  const { data: rows, error } = await db.from('time_off_requests')
    .update({ ...CLEARED_CANCEL_ASK, updated_at: new Date().toISOString() })
    .eq('id', existing.id)
    .eq('profile_id', user.id)
    .eq('status', 'approved')
    .not('cancel_requested_at', 'is', null)
    .is('cancel_decided_at', null)
    .select(REQUEST_WITH_PEOPLE)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  if (!rows || rows.length === 0) {
    return NextResponse.json({
      success: false,
      error: 'An owner decided this a moment ago, so it was not withdrawn. Refresh to see where it stands.',
    }, { status: 409 })
  }

  // No notice: the item simply leaves the owners' queue.
  return NextResponse.json({ success: true, data: rows[0], cancellation: 'withdrawn' })
}
