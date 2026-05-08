// POST /api/admin/assignments — Master-only single-cell mutation route
// for the /admin/matrix v2 access editor.
//
// One route, three actions (chosen via body.action) so the matrix UI
// can call a single endpoint regardless of whether it's adding,
// updating, or removing a (profile_id, location_id) pairing:
//
//   create  — insert a new profile_locations row (assigning a user to
//             a location). Requires: profile_id, location_id, role.
//   update  — change the role on an existing row. Requires:
//             profile_id, location_id, role.
//   delete  — remove the row entirely. Requires: profile_id,
//             location_id. Honours canRemoveSelfFromLastOwnerLocation.
//
// Audit: every successful mutation appends to assignment_change_log
// via logAssignmentChange. Every failed mutation does NOT log (we
// don't want a noisy log of attempted-but-rejected operations).
//
// Auth: master only — checked at the route boundary via getCurrentUser.
// The DB layer also enforces (RLS on profile_locations is
// owner-at-target-location for the authenticated channel; the master
// short-circuits both via private.auth_is_master and via the service
// role used by createServerClient).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike, locationRoleSchema } from '@/lib/schemas'
import {
  logAssignmentChange,
  canRemoveSelfFromLastOwnerLocation,
} from '@/lib/assignment-changes'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    profile_id: uuidLike,
    location_id: uuidLike,
    role: locationRoleSchema,
  }),
  z.object({
    action: z.literal('update'),
    profile_id: uuidLike,
    location_id: uuidLike,
    role: locationRoleSchema,
  }),
  z.object({
    action: z.literal('delete'),
    profile_id: uuidLike,
    location_id: uuidLike,
  }),
])

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  if (user.profileRole !== 'master') {
    return NextResponse.json({ success: false, error: 'Master only' }, { status: 403 })
  }

  const validation = await validateBody(request, Body)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()

  // Snapshot the existing row up front. Useful for the before/after
  // payload, and required for update + delete to know what was there.
  const { data: existing } = await db
    .from('profile_locations')
    .select('*')
    .eq('profile_id', body.profile_id)
    .eq('location_id', body.location_id)
    .maybeSingle()

  if (body.action === 'create') {
    if (existing) {
      return NextResponse.json({
        success: false,
        error: 'Assignment already exists. Use action=update to change the role.',
      }, { status: 409 })
    }

    const { data: created, error: insertErr } = await db
      .from('profile_locations')
      .insert({
        profile_id: body.profile_id,
        location_id: body.location_id,
        role: body.role,
      })
      .select()
      .single()
    if (insertErr) {
      return NextResponse.json({ success: false, error: insertErr.message }, { status: 400 })
    }

    await logAssignmentChange(db, {
      actorId: user.id,
      targetProfileId: body.profile_id,
      locationId: body.location_id,
      action: 'assignment_create',
      before: null,
      after: created,
    })

    return NextResponse.json({ success: true, data: created })
  }

  if (body.action === 'update') {
    if (!existing) {
      return NextResponse.json({
        success: false,
        error: 'Assignment not found. Use action=create to add it.',
      }, { status: 404 })
    }
    if (existing.role === body.role) {
      // No-op — return success but skip audit (nothing changed).
      return NextResponse.json({ success: true, data: existing, no_op: true })
    }

    const { data: updated, error: upErr } = await db
      .from('profile_locations')
      .update({ role: body.role })
      .eq('profile_id', body.profile_id)
      .eq('location_id', body.location_id)
      .select()
      .single()
    if (upErr) {
      return NextResponse.json({ success: false, error: upErr.message }, { status: 400 })
    }

    await logAssignmentChange(db, {
      actorId: user.id,
      targetProfileId: body.profile_id,
      locationId: body.location_id,
      action: 'assignment_update',
      before: existing,
      after: updated,
    })

    return NextResponse.json({ success: true, data: updated })
  }

  if (body.action === 'delete') {
    if (!existing) {
      return NextResponse.json({
        success: false,
        error: 'Assignment not found.',
      }, { status: 404 })
    }

    // Self-orphan guard: editing your own owner assignment? Make sure
    // you have at least one OTHER owner-at-some-location assignment so
    // you don't lock yourself out.
    if (existing.role === 'owner') {
      try {
        const guard = await canRemoveSelfFromLastOwnerLocation(
          db,
          user.id,
          body.profile_id,
          body.location_id,
        )
        if (guard.wouldOrphan) {
          return NextResponse.json({
            success: false,
            error: 'You cannot remove yourself from your last owner location. Promote yourself at another location first, or have another master remove this assignment.',
            code: 'self_orphan_owner',
          }, { status: 409 })
        }
      } catch (e) {
        logWarn('admin/assignments', `self-orphan check failed`, { err: e })
        // Fail closed on guard errors — better to refuse than risk orphaning.
        return NextResponse.json({
          success: false,
          error: 'Could not verify self-orphan guard. Try again.',
        }, { status: 503 })
      }
    }

    const { error: delErr } = await db
      .from('profile_locations')
      .delete()
      .eq('profile_id', body.profile_id)
      .eq('location_id', body.location_id)
    if (delErr) {
      return NextResponse.json({ success: false, error: delErr.message }, { status: 400 })
    }

    await logAssignmentChange(db, {
      actorId: user.id,
      targetProfileId: body.profile_id,
      locationId: body.location_id,
      action: 'assignment_delete',
      before: existing,
      after: null,
    })

    return NextResponse.json({ success: true })
  }

  // Unreachable due to the discriminated union, but defensive.
  return NextResponse.json({ success: false, error: 'Unknown action' }, { status: 400 })
}
