import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, isoDate , MANAGER_ROLES} from '@/lib/schemas'
import { bulkUpsertShiftAssignments } from '@/lib/roster-write'
import { fetchSourceShiftRows } from '@/lib/roster-read'

const CopyWeekSchema = z.object({
  location_id: uuidLike,
  source_start: isoDate,
  target_start: isoDate,
})

// POST /api/schedule/shifts/copy-week
// Copy all shifts from one week to another
// Body: { location_id, source_start (Mon), target_start (Mon) }
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const validation = await validateBody(request, CopyWeekSchema)
  if (!validation.ok) return validation.response
  const { location_id, source_start, target_start } = validation.data

  const guard = assertLocationAccess(user, location_id)
  if (guard) return guard

  const db = createServerClient()

  // Calculate source week end (source_start + 6 days)
  const sourceStartDate = new Date(source_start + 'T00:00:00')
  const sourceEndDate = new Date(sourceStartDate)
  sourceEndDate.setDate(sourceEndDate.getDate() + 6)
  const sourceEnd = sourceEndDate.toISOString().split('T')[0]

  // Fetch source shifts from the Roster v2 model (blocks + assignments).
  const { rows: sourceRows, error: fetchError } = await fetchSourceShiftRows(db, {
    locationId: location_id,
    startDate: source_start,
    endDate: sourceEnd,
  })

  if (fetchError) return NextResponse.json({ success: false, error: fetchError.message }, { status: 400 })

  if (!sourceRows || sourceRows.length === 0) {
    return NextResponse.json({ success: false, error: 'No shifts found in the source week' }, { status: 404 })
  }

  // Calculate day offset between source and target
  const targetStartDate = new Date(target_start + 'T00:00:00')
  const dayOffset = Math.round((targetStartDate - sourceStartDate) / (1000 * 60 * 60 * 24))

  // Re-date each source row into the target week.
  const newRows = sourceRows.map((r) => {
    const shiftDate = new Date(r.shiftDate + 'T00:00:00')
    shiftDate.setDate(shiftDate.getDate() + dayOffset)
    return {
      profileId: r.profileId,
      shiftTemplateId: r.shiftTemplateId,
      shiftDate: shiftDate.toISOString().split('T')[0],
      startTimeOverride: r.startTimeOverride,
      endTimeOverride: r.endTimeOverride,
      notes: r.notes,
      status: 'scheduled',
    }
  })

  // Find-or-create blocks + upsert assignments (new model). Newly-created
  // blocks carry no roster_id, so the copied shifts read as unpublished
  // until the manager publishes — same as the legacy published:false.
  const { count, error } = await bulkUpsertShiftAssignments(db, {
    locationId: location_id,
    actorId: user.id,
    rows: newRows,
  })

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, copied: count }, { status: 201 })
}
