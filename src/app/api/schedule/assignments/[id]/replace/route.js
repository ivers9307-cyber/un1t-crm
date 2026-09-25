// src/app/api/schedule/assignments/[id]/replace/route.js
//
// REPLACE.1a — POST: hand this assignment from its coach (A) to another coach
// (B) in ONE action. Body: { profile_id: B, confirm_conflicts?: true }.
//
// Mutation skeleton (CLAUDE.md): user -> coarse role check -> body -> the row
// -> the row's studio (404 outsider, 403 non-manager there) -> rules -> write
// -> log -> notice. The rules and their reasons: src/lib/shift-replace.js.
//
//   - Refusals are replaceRefusal (src/lib/shift-replace.js): started (the
//     one predicate), arrived, not a member, not rosterable, already on it.
//   - Leave / another shift that day for B: 409 swap_conflicts with the
//     sentences unless confirm_conflicts (the swap approval's step, SWAPS.2).
//   - The move is ONE guarded UPDATE (src/lib/shift-replace-server.js).
//   - Published roster: two change-log rows (via 'replace') and ONE notice
//     each through notifyRosterChanges, from after() inside 07:00-22:00
//     studio time; outside it the rows stay unstamped and the */5 arm
//     (src/lib/shift-replace-notify.js) sends them from 07:00. Draft: nothing.

import { NextResponse, after } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'
import { findSwapConflicts } from '@/lib/swap-conflicts'
import { SWAP_CONFLICTS_CODE } from '@/lib/swap-lifecycle'
import { logRosterChange } from '@/lib/roster-change-log'
import { notifyRosterChanges } from '@/lib/roster-change-notify'
import { inStaffPushHours } from '@/lib/staff-push-hours'
import { readReplaceContext, replaceShiftAssignment } from '@/lib/shift-replace-server'
import {
  replaceRefusal, replaceRefusalResponse, replaceShiftStarted, replaceChanges, replaceNoticeWhen, REPLACE_VIA,
} from '@/lib/shift-replace'
import { logError } from '@/lib/log'

const ReplaceSchema = z.object({
  profile_id: uuidLike,
  confirm_conflicts: z.boolean().optional(),
})

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  // Coarse only (SCHEDROLES.1): the real decision is at the block's studio.
  if (!hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Only a manager can replace a coach' }, { status: 403 })
  }

  // A malformed id is an id that does not exist: 404, nothing read.
  if (!uuidLike.safeParse(params?.id).success) {
    return NextResponse.json({ success: false, error: 'Assignment not found' }, { status: 404 })
  }

  const validation = await validateBody(request, ReplaceSchema)
  if (!validation.ok) return validation.response
  const toProfileId = validation.data.profile_id
  const confirmConflicts = validation.data.confirm_conflicts === true

  const db = createServerClient()
  const ctx = await readReplaceContext(db, { assignmentId: params.id, toProfileId })
  if (ctx.error) return NextResponse.json({ success: false, error: 'Could not read the shift' }, { status: 500 })
  if (!ctx.assignment || !ctx.block?.location_id) {
    return NextResponse.json({ success: false, error: 'Assignment not found' }, { status: 404 })
  }
  const notHere = assertLocationAccessOr404(user, ctx.block.location_id)
  if (notHere) return notHere
  if (!hasRoleAtLocation(user, ctx.block.location_id, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Only a manager at this studio can replace a coach' }, { status: 403 })
  }

  const nowMs = Date.now()
  const tz = ctx.block.locations?.timezone ?? null
  const refused = replaceRefusal({ ...ctx, toProfileId, started: replaceShiftStarted(ctx, nowMs, tz) })
  if (refused) {
    return NextResponse.json({ success: false, code: refused.code, error: refused.error }, { status: refused.status })
  }

  if (!confirmConflicts) {
    const conflicts = await findSwapConflicts(db,
      [{ role: 'taker', coachId: toProfileId, block: ctx.block, leavingAssignmentId: null }],
      { viewerId: user.id })
    if (conflicts.length > 0) {
      return NextResponse.json({
        success: false, code: SWAP_CONFLICTS_CODE, error: conflicts.map((c) => c.message).join(' '), conflicts,
      }, { status: 409 })
    }
  }

  const write = await replaceShiftAssignment(db, {
    assignment: ctx.assignment, toProfileId, actorId: user.id, nowIso: new Date(nowMs).toISOString(),
  })
  if (write.error) return NextResponse.json({ success: false, error: 'Could not replace the coach' }, { status: 500 })
  if (write.code) {
    const { status, body } = replaceRefusalResponse(write.code)
    return NextResponse.json(body, { status })
  }

  const published = ctx.block.rosters?.status === 'published'
  const changes = replaceChanges({ block: ctx.block, fromProfileId: ctx.assignment.profile_id, toProfileId })
  const notice = replaceNoticeWhen({ published, inBand: inStaffPushHours(nowMs, tz) })
  if (published) {
    // Best-effort (logRosterChange never throws). Written after the move
    // succeeded, so the log never claims a replace that did not happen.
    for (const c of changes) {
      const logged = await logRosterChange(db, {
        isPublished: true,
        locationId: ctx.block.location_id,
        blockId: c.blockId,
        blockDate: c.blockDate,
        actorId: user.id,
        coachId: c.coachId,
        action: c.action,
        details: { via: REPLACE_VIA },
      })
      // Out of band the row IS the held notice: the */5 arm sends what it
      // finds. A row that was not written is a notice nobody will send, so
      // say so loudly (the replace itself stands).
      if (!logged?.logged && notice === 'morning') {
        logError('shift-replace', 'replace change-log row not written; its held notice will not be sent', {
          assignmentId: ctx.assignment.id, coachId: c.coachId, action: c.action, reason: logged?.reason ?? null,
        })
      }
    }
  }

  if (notice === 'now') {
    // notifyRosterChanges never throws (it catches per coach); what can go
    // wrong comes back in its result. A lost stamp after a delivery, or a
    // failed send, leaves that coach's rows unstamped, and the */5 arm sends
    // them again after its 2-minute window: a duplicate at worst, never a loss.
    after(async () => {
      const res = await notifyRosterChanges(db, { locationId: ctx.block.location_id, actorId: user.id, changes })
      if ((res?.stampFailed || 0) > 0 || (res?.failed || 0) > 0) {
        logError('shift-replace', 'replace notice not fully settled; the */5 arm sends the unstamped rows (a coach may be told again)', {
          assignmentId: ctx.assignment.id, stampFailed: res?.stampFailed || 0, failed: res?.failed || 0,
        })
      }
    })
  }

  return NextResponse.json({
    success: true,
    data: {
      assignment_id: ctx.assignment.id,
      from_profile_id: ctx.assignment.profile_id,
      profile_id: toProfileId,
      notice,
      closed_swaps: write.closedSwapIds.length,
    },
  })
}
