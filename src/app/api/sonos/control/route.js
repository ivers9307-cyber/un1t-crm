// SONOSLIVE.4 — immediate live control. One action-dispatched route rather
// than six sub-routes (six auth checks, six OpenAPI entries, no benefit) or
// a pass-through proxy (an unbounded action set cannot be permission-gated).
//
// SONOSGRP.2 — dual addressing: the body carries exactly one of schedule_id
// (uuid, resolved to groups via the location-scoped schedule row) or
// group_id (an opaque Sonos group id straight from GET /api/sonos/household
// — NOT a uuid, so no uuid check). Group ids are ephemeral by design: a
// stale one answers `regrouped`, and the caller refetches the household.
//
// Thin by design: runLiveAction (src/lib/sonos/live.js) is the tested body,
// including the assertion that it writes nothing to sonos_schedules. This
// file only authorises, validates the request, and maps result codes to
// HTTP statuses and operator-readable copy.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { uuidLike } from '@/lib/schemas'
import { ACTIONS } from '@/lib/sonos/actions'
import { runLiveAction } from '@/lib/sonos/live'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  schedule_id: z.string().optional(),
  group_id: z.string().min(1).max(128).optional(),
  action: z.enum(ACTIONS),
  value: z.union([z.number(), z.string()]).optional(),
}).refine((b) => Boolean(b.schedule_id) !== Boolean(b.group_id), {
  message: 'Exactly one of schedule_id or group_id',
})

// Result code → HTTP status + what the operator reads.
const OUTCOME = {
  invalid:        [400, 'Invalid request'],
  not_found:      [404, 'Not found'],
  not_configured: [503, 'Sonos is not configured'],
  not_connected:  [409, 'Sonos is not connected'],
  no_group:       [409, 'None of this schedule’s speakers are online'],
  fixed_volume:   [409, 'These speakers are set to a fixed volume, so it cannot be changed from here'],
  regrouped:      [409, 'The speakers regrouped — refresh and try again'],
  no_content:     [409, 'Nothing is loaded on these speakers — pick a favourite first'],
  rate_limited:   [429, 'Too many changes at once — give it a moment'],
  unreachable:    [502, 'Sonos is not answering right now'],
  db_error:       [500, 'Something went wrong'],
  failed:         [502, 'That did not work'],
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'device_control')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })

  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Invalid request' }, { status: 400 })
  }
  const { schedule_id: scheduleId, group_id: groupId, action, value } = parsed.data
  // Only schedule ids are uuids — group ids are opaque Sonos strings
  // (RINCON_…:N), bounded by the schema above.
  if (scheduleId && !uuidLike.safeParse(scheduleId).success) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const db = createServerClient()
  const out = await runLiveAction(db, locationId, scheduleId ? { scheduleId } : { groupId }, action, value)
  if (out.ok) return NextResponse.json({ success: true, groups: out.groups })

  const [status, message] = OUTCOME[out.code] || [502, 'That did not work']
  // volume_up/volume_down are relative, not idempotent: on a multi-group
  // schedule where one group's call succeeded before another failed, a
  // caller that blindly retries the whole action on a bare failure would
  // re-apply the step to the group already in `applied`. Pass both through
  // so the UI can retry only what's in `failedGroups`.
  const body = { success: false, error: message, code: out.code }
  if (out.applied) body.applied = out.applied
  if (out.failedGroups) body.failedGroups = out.failedGroups
  return NextResponse.json(body, { status })
}
