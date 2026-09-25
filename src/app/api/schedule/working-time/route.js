// WORKTIME.1 — GET /api/schedule/working-time?block_id=<uuid>
//
// For the assign picker: for each EMPLOYEE of the block's studio who is not
// already on it, would assigning them to this block leave fewer than 11 hours
// between working days, or more than 48 rostered hours in its Mon-Sun week,
// counting their shifts at every studio of this organisation? ADVISORY ONLY:
// the picker shows a badge and the row stays tickable. POST
// /api/schedule/blocks/[id]/assignments is unchanged and never consults this.
//
// Gate: MANAGER_ROLES AT the block's studio (the assign route's gate). An
// outsider to that studio gets 404, so the block id is never confirmed.
//
// Returns { success, data: { byProfile: { [profileId]: { restGap, weekHours } },
// checked } }. Only people with something to say are listed; contractors never
// are. Shift times and hours only: no name, rate, cost, contract hours or
// employment type leaves this route. `checked: false` = the read failed or
// could not see the other studios, so an empty map is not an all-clear.
//
// The path deliberately avoids `/schedule/blocks`: calendar tests route that
// substring to the block list and count block reads.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'
import { liveAssignments } from '@/lib/roster'
import { mondayOf } from '@/lib/payroll'
import { addDaysISO } from '@/lib/dublin-time'
import { loadWorkingTimeShifts } from '@/lib/working-time-data'
import { candidateWorkingTime, isWorkingTimeCovered } from '@shared/working-time'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const QuerySchema = z.object({ block_id: uuidLike })

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user || !hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const url = new URL(request.url)
  const parsed = QuerySchema.safeParse({ block_id: url.searchParams.get('block_id') })
  if (!parsed.success) {
    return NextResponse.json({
      success: false,
      error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, { status: 400 })
  }

  const db = createServerClient()

  // Block lookup: also the studio-ownership gate.
  const { data: block, error: blockErr } = await db
    .from('shift_blocks')
    .select('id, location_id, block_date, start_time, end_time, shift_templates(name, start_time, end_time), shift_assignments(profile_id, status)')
    .eq('id', parsed.data.block_id)
    .maybeSingle()
  if (blockErr) return NextResponse.json({ success: false, error: blockErr.message }, { status: 500 })
  if (!block) return NextResponse.json({ success: false, error: 'Block not found' }, { status: 404 })

  const notHere = assertLocationAccessOr404(user, block.location_id)
  if (notHere) return notHere
  if (!hasRoleAtLocation(user, block.location_id, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  // The people the picker offers: this studio's members, minus anyone already
  // live on the block. The reader keeps employees only.
  const { data: members, error: memberErr } = await db
    .from('profile_locations')
    .select('profile_id')
    .eq('location_id', block.location_id)
  if (memberErr) return NextResponse.json({ success: false, error: memberErr.message }, { status: 500 })
  const onBlock = new Set(liveAssignments(block.shift_assignments).map((a) => a.profile_id))
  const candidateIds = [...new Set((members || []).map((m) => m.profile_id).filter((id) => id && !onBlock.has(id)))]

  // The block's Mon-Sun week, one day either side: every rest gap and the
  // week total the candidate could touch.
  const monday = mondayOf(block.block_date)
  const wt = await loadWorkingTimeShifts(db, {
    locationId: block.location_id,
    profileIds: candidateIds,
    from: addDaysISO(monday, -1),
    to: addDaysISO(monday, 7),
  })

  const byProfile = {}
  if (!wt.error) {
    for (const profileId of candidateIds) {
      if (!isWorkingTimeCovered(wt.people.get(profileId)?.employment_type)) continue
      const result = candidateWorkingTime(
        wt.shifts.filter((s) => s.profile_id === profileId),
        {
          profile_id: profileId,
          block_id: block.id,
          block_date: block.block_date,
          location_id: block.location_id,
          location_name: null,
          name: block.shift_templates?.name || 'Shift',
          start_time: block.start_time,
          end_time: block.end_time,
          shift_templates: block.shift_templates,
        },
        { hereLocationId: block.location_id },
      )
      if (result.restGap || result.weekHours) byProfile[profileId] = result
    }
  }

  return NextResponse.json({ success: true, data: { byProfile, checked: !wt.error && wt.crossStudioChecked !== false } })
}
