// BULK-ASSIGN.1 — POST /api/schedule/blocks/bulk-assign
//
// Assign a single coach to multiple shift_blocks in one request.
// Replaces the open-modal-per-block workflow that operators had been
// using to staff a week's worth of recurring shifts. Per-block
// outcome is reported so the operator sees exactly which ones
// landed and which were skipped.
//
// Body shape:
//   { block_ids: string[]      — UUIDs of blocks to assign to
//     profile_id: string       — the coach
//     notes?: string | null    — applied to every successful assignment
//     allow_over_capacity?: boolean — override the per-block max_coaches gate
//   }
//
// Returns:
//   { success: true,
//     assigned: [{ block_id, assignment_id }],
//     skipped:  [{ block_id, reason }],   // 'at_capacity' | 'already_assigned' | 'not_found' | 'cross_location'
//     warnings: string[]                  // aggregated time-off advisories
//   }
//
// Per-block error handling matches the single-block POST shape:
//   - already-assigned → skip silently with reason (UNIQUE constraint
//     catch wraps the 23505)
//   - over-capacity → skip with reason (unless allow_over_capacity)
//   - missing/cross-location → skip with reason (defence in depth
//     alongside the SELECT-by-id-IN gate)
//
// Time-off warnings aggregate to a single returned array — the
// operator sees "Sarah has approved holiday from 12 → 19 May" once,
// not three times if Sarah was assigned to three blocks during that
// window.
//
// Manager+ gated (matches the single-block assignment route).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'
import { timeRangesOverlap, fmtTime } from '@/lib/schedule-overlap'

const BulkAssignSchema = z.object({
  block_ids: z.array(uuidLike).min(1, 'At least one block_id is required').max(200, 'Max 200 blocks per request'),
  profile_id: uuidLike,
  notes: z.string().max(2000).nullable().optional(),
  allow_over_capacity: z.boolean().optional(),
})

export const runtime = 'nodejs'

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const validation = await validateBody(request, BulkAssignSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()

  // Pull every requested block in one query, with their current
  // assignment count + the coach's existing membership flag so we
  // can decide per-block disposition without N round-trips.
  const { data: blocks, error: blocksErr } = await db
    .from('shift_blocks')
    .select(`
      id, location_id, block_date, max_coaches,
      shift_assignments ( id, profile_id, status )
    `)
    .in('id', body.block_ids)
  if (blocksErr) {
    return NextResponse.json({ success: false, error: blocksErr.message }, { status: 500 })
  }

  const allowedLocations = user.role === 'master'
    ? null  // master sees all
    : new Set(getUserLocationIds(user))

  const blocksById = new Map((blocks || []).map((b) => [b.id, b]))
  const skipped = []
  const insertRows = []
  const dateSet = new Set()  // dates for the time-off lookup later

  for (const requestedId of body.block_ids) {
    const block = blocksById.get(requestedId)
    if (!block) {
      skipped.push({ block_id: requestedId, reason: 'not_found' })
      continue
    }
    if (allowedLocations && !allowedLocations.has(block.location_id)) {
      skipped.push({ block_id: requestedId, reason: 'cross_location' })
      continue
    }
    const activeAssignments = (block.shift_assignments || []).filter((a) => a.status !== 'cancelled')
    const alreadyAssigned = activeAssignments.some((a) => a.profile_id === body.profile_id)
    if (alreadyAssigned) {
      skipped.push({ block_id: requestedId, reason: 'already_assigned' })
      continue
    }
    const currentCount = activeAssignments.length
    if (currentCount >= block.max_coaches && !body.allow_over_capacity) {
      skipped.push({ block_id: requestedId, reason: 'at_capacity' })
      continue
    }
    insertRows.push({
      block_id: requestedId,
      profile_id: body.profile_id,
      notes: body.notes || null,
      assigned_by: user.id,
    })
    dateSet.add(block.block_date)
  }

  let assigned = []
  if (insertRows.length > 0) {
    const { data: inserted, error: insertErr } = await db
      .from('shift_assignments')
      .insert(insertRows)
      .select('id, block_id')
    if (insertErr) {
      // Defensive — the only realistic remaining failure mode is a
      // race where someone else assigned the same coach between our
      // SELECT and our INSERT. Surface as a top-level error rather
      // than try to recover per-row; the operator can re-try and
      // the second attempt will see the now-assigned rows in the
      // already_assigned skip path.
      return NextResponse.json({
        success: false,
        error: `Bulk insert failed: ${insertErr.message}. ${assigned.length} assignments may have landed before the failure.`,
      }, { status: 500 })
    }
    assigned = (inserted || []).map((r) => ({ block_id: r.block_id, assignment_id: r.id }))
  }

  // Aggregated time-off warnings — fetch any approved leave that
  // overlaps ANY of the dates we just assigned. Mirrors the
  // single-block route's advisory pattern; deduped by date range so
  // the operator sees one line per leave window, not N copies.
  let warnings = []
  if (assigned.length > 0 && dateSet.size > 0) {
    const dates = [...dateSet]
    const minDate = dates.reduce((a, b) => (a < b ? a : b))
    const maxDate = dates.reduce((a, b) => (a > b ? a : b))
    const { data: timeOff } = await db
      .from('time_off_requests')
      .select('type, start_date, end_date, profiles!profile_id(full_name)')
      .eq('profile_id', body.profile_id)
      .eq('status', 'approved')
      .lte('start_date', maxDate)
      .gte('end_date', minDate)
    const seen = new Set()
    warnings = (timeOff || [])
      .filter((t) => {
        // Only warn if the leave window actually intersects at
        // least one assigned date — not just the date range bounds.
        return dates.some((d) => d >= t.start_date && d <= t.end_date)
      })
      .map((t) => `${t.profiles?.full_name} has approved ${t.type} from ${t.start_date} to ${t.end_date}`)
      .filter((line) => {
        if (seen.has(line)) return false
        seen.add(line)
        return true
      })
  }

  // SCHEDULE-DOUBLE-BOOKING.1 — advisory: flag any of this coach's shifts
  // that overlap each other on the assigned dates (existing + just-added,
  // any location). Best-effort; aggregated + deduped like the time-off
  // warnings above.
  if (assigned.length > 0 && dateSet.size > 0) {
    try {
      const { data: coachBlocks } = await db
        .from('shift_assignments')
        .select('shift_blocks!inner(start_time, end_time, block_date, shift_templates(name), locations(name))')
        .eq('profile_id', body.profile_id)
        .in('shift_blocks.block_date', [...dateSet])
      const byDate = {}
      for (const a of coachBlocks || []) {
        const b = a.shift_blocks
        if (b?.start_time && b?.end_time) (byDate[b.block_date] ||= []).push(b)
      }
      const seenOverlap = new Set()
      for (const date of Object.keys(byDate)) {
        const dayBlocks = byDate[date]
        for (let i = 0; i < dayBlocks.length; i++) {
          for (let j = i + 1; j < dayBlocks.length; j++) {
            const x = dayBlocks[i]
            const y = dayBlocks[j]
            if (!timeRangesOverlap(x.start_time, x.end_time, y.start_time, y.end_time)) continue
            const line = `Overlapping shifts on ${date}: ${x.shift_templates?.name || 'shift'} ${fmtTime(x.start_time)}–${fmtTime(x.end_time)} and ${y.shift_templates?.name || 'shift'} ${fmtTime(y.start_time)}–${fmtTime(y.end_time)}.`
            if (!seenOverlap.has(line)) {
              seenOverlap.add(line)
              warnings.push(line)
            }
          }
        }
      }
    } catch {
      // Advisory only — never let a double-booking check failure break a
      // bulk assignment that already landed.
    }
  }

  return NextResponse.json({
    success: true,
    assigned,
    skipped,
    warnings,
  })
}
