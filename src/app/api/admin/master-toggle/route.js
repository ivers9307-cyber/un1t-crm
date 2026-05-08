// POST /api/admin/master-toggle — Master-only route to promote a user
// to master, or demote a master back to a per-location role.
//
// Promotion:
//   - Sets profiles.role = 'master' (the at-least-one-master invariant
//     trivially holds — promotion only INCREASES master count).
//   - The user's existing per-location role assignments are preserved
//     (they keep their owner-at-Hatch row even after promotion to master).
//
// Demotion:
//   - Sets profiles.role = the supplied fallback role (default 'staff').
//   - Calls wouldLeaveZeroMasters BEFORE the UPDATE so the user gets a
//     clean error message ("Promote another user to master first") rather
//     than a raw Postgres trigger error from the DB-layer guard.
//   - The DB trigger (private.guard_at_least_one_master) is the
//     unconditional second line of defence — if a future code path
//     forgets to call this guard, the trigger still rejects the operation
//     and surfaces a check_violation error.
//
// Audit: master_promote / master_demote entries written to
// assignment_change_log with the role before/after.
//
// Self-demotion is allowed (subject to the at-least-one-master rule)
// — a master should be able to step down without administrative help
// AS LONG AS another master exists to take over.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import {
  wouldLeaveZeroMasters,
  logAssignmentChange,
} from '@/lib/assignment-changes'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('promote'),
    profile_id: uuidLike,
  }),
  z.object({
    action: z.literal('demote'),
    profile_id: uuidLike,
    // Role to fall back to. Defaults to 'staff' — the safest minimum.
    // Master can change it via the staff form afterwards.
    fallback_role: z.enum(['owner', 'manager', 'head_coach', 'staff']).default('staff'),
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

  const { data: existing, error: lookupErr } = await db
    .from('profiles')
    .select('id, role, active, full_name, email')
    .eq('id', body.profile_id)
    .single()
  if (lookupErr || !existing) {
    return NextResponse.json({ success: false, error: 'Target user not found' }, { status: 404 })
  }
  if (!existing.active) {
    return NextResponse.json({
      success: false,
      error: 'Target user is deactivated. Reactivate before changing master status.',
    }, { status: 409 })
  }

  if (body.action === 'promote') {
    if (existing.role === 'master') {
      return NextResponse.json({ success: true, data: existing, no_op: true })
    }
    const { data: updated, error: upErr } = await db
      .from('profiles')
      .update({ role: 'master' })
      .eq('id', body.profile_id)
      .select()
      .single()
    if (upErr) {
      return NextResponse.json({ success: false, error: upErr.message }, { status: 400 })
    }
    await logAssignmentChange(db, {
      actorId: user.id,
      targetProfileId: body.profile_id,
      locationId: null,
      action: 'master_promote',
      before: { role: existing.role },
      after: { role: 'master' },
    })
    return NextResponse.json({ success: true, data: updated })
  }

  // body.action === 'demote'
  if (existing.role !== 'master') {
    return NextResponse.json({
      success: false,
      error: 'Target user is not a master.',
    }, { status: 409 })
  }

  // App-layer guard — friendly error before the DB trigger speaks up.
  let guard
  try {
    guard = await wouldLeaveZeroMasters(db, body.profile_id)
  } catch (e) {
    logWarn('master-toggle', `guard check failed`, { err: e })
    return NextResponse.json({
      success: false,
      error: 'Could not verify master-count guard. Try again.',
    }, { status: 503 })
  }
  if (guard.wouldLeave) {
    return NextResponse.json({
      success: false,
      error: 'Cannot demote the last active master. Promote another user to master first.',
      code: 'last_master_protection',
      currentMasters: guard.currentMasters,
    }, { status: 409 })
  }

  const { data: updated, error: upErr } = await db
    .from('profiles')
    .update({ role: body.fallback_role })
    .eq('id', body.profile_id)
    .select()
    .single()
  if (upErr) {
    // Could be the DB trigger if the app-layer check raced and was
    // overtaken by another concurrent demotion. Surface the message.
    return NextResponse.json({ success: false, error: upErr.message }, { status: 400 })
  }
  await logAssignmentChange(db, {
    actorId: user.id,
    targetProfileId: body.profile_id,
    locationId: null,
    action: 'master_demote',
    before: { role: 'master' },
    after: { role: body.fallback_role },
  })
  return NextResponse.json({ success: true, data: updated })
}
