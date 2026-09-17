// POST /api/schedule/time-off/[id]/unassign-clashes
//
// LEAVE.1 — the explicit follow-up to approving leave. Approval never touches
// the roster on its own (three contractor shifts stayed live over approved
// "unavailable" days because nobody was shown them); the approve response
// lists the clashes and this takes the person off them when the approver
// says so.
//
// Gates, in order:
//   • the caller can DECIDE this request (time-off approval permission at a
//     studio it belongs to) — otherwise 404, the id is not confirmed;
//   • the request is approved — unassigning for pending leave would act on a
//     decision nobody has made (409);
//   • per shift, the caller is a manager AT THAT SHIFT's studio — the exact
//     gate DELETE /api/schedule/assignments/[id] applies. Shifts they cannot
//     manage are reported as skipped, never removed.
// Removal goes through unassignShiftAssignments, the helper that DELETE uses,
// so the change log and the NOTIFY.1 coach notification happen the same way.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, hasRoleAtLocation } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'
import { dublinTodayStr } from '@/lib/dublin-time'
import { canDecideTimeOff, getProfileLocationIds, findLeaveClashes } from '@/lib/time-off-leave'
import { unassignShiftAssignments } from '@/lib/shift-unassign'

const UnassignSchema = z.object({
  // Optional: only these assignments (the ones the approver was shown). A
  // clash that appeared since is left alone rather than removed unseen.
  assignment_ids: z.array(uuidLike).min(1).max(200).optional(),
})

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, UnassignSchema)
  if (!validation.ok) return validation.response
  const { assignment_ids } = validation.data

  const db = createServerClient()

  const { data: leave, error: leaveError } = await db.from('time_off_requests')
    .select('id, profile_id, location_id, status, type, start_date, end_date')
    .eq('id', params.id)
    .maybeSingle()
  if (leaveError) return NextResponse.json({ success: false, error: leaveError.message }, { status: 500 })
  if (!leave) return NextResponse.json({ success: false, error: 'Request not found' }, { status: 404 })

  const { ids: requesterLocations, error: locError } = await getProfileLocationIds(db, leave.profile_id)
  if (locError) return NextResponse.json({ success: false, error: locError.message }, { status: 500 })
  if (!canDecideTimeOff(user, leave.location_id, requesterLocations)) {
    return NextResponse.json({ success: false, error: 'Request not found' }, { status: 404 })
  }
  if (leave.status !== 'approved') {
    return NextResponse.json({ success: false, error: 'Only approved leave can clear the roster' }, { status: 409 })
  }

  const { clashes, error: clashError } = await findLeaveClashes(db, leave, dublinTodayStr())
  if (clashError) return NextResponse.json({ success: false, error: clashError.message }, { status: 500 })

  const wanted = assignment_ids ? new Set(assignment_ids) : null
  const isMaster = user.profileRole === 'master'
  const toRemove = []
  const skipped = []
  for (const c of clashes) {
    if (wanted && !wanted.has(c.id)) continue
    if (!isMaster && !hasRoleAtLocation(user, c.location_id, MANAGER_ROLES)) {
      skipped.push({ assignment_id: c.id, block_date: c.block_date, location_name: c.location_name, reason: 'not_manager_at_location' })
      continue
    }
    toRemove.push(c)
  }

  const { removed, failed } = await unassignShiftAssignments(db, { actorId: user.id, assignments: toRemove })

  return NextResponse.json({
    success: failed.length === 0,
    ...(failed.length ? { error: `${failed.length} shift${failed.length === 1 ? '' : 's'} could not be unassigned` } : {}),
    data: {
      removed: removed.map((c) => ({ assignment_id: c.id, block_date: c.block_date, location_name: c.location_name })),
      skipped,
      failed,
    },
  }, { status: failed.length && removed.length === 0 ? 500 : 200 })
}
