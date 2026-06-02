import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, getUserLocationIds } from '@/lib/auth'

// RETIRE-SHIFTS-MIRROR.5 — the POST create-shift handler (and the PUT/DELETE
// /[id] routes) were removed: they wrote the legacy public.shifts table, had
// no UI/mobile caller (the app uses the block-based assign routes), and no
// external/n8n consumer. GET below still serves shifts (reader phase 5).

// GET /api/schedule/shifts?location_id=xxx&start_date=2026-04-27&end_date=2026-05-03&profile_id=xxx
export async function GET(request) {
  const user = await getCurrentUser()
  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const startDate = searchParams.get('start_date')
  const endDate = searchParams.get('end_date')
  const profileId = searchParams.get('profile_id')
  const db = createServerClient()

  let query = db.from('shifts')
    .select('*, shift_templates(*), profiles!profile_id(id, full_name, email, avatar_url, role)')
    .order('shift_date')

  if (locationId) {
    query = query.eq('location_id', locationId)
  } else {
    // No specific location requested — limit to caller's own locations.
    const userLocationIds = getUserLocationIds(user)
    if (userLocationIds.length === 0) {
      return NextResponse.json({ success: true, data: [] })
    }
    query = query.in('location_id', userLocationIds)
  }
  if (startDate) query = query.gte('shift_date', startDate)
  if (endDate) query = query.lte('shift_date', endDate)
  if (profileId) query = query.eq('profile_id', profileId)

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  // Mobile partial-shift editor needs the shift_assignments.id for
  // PUT /api/schedule/assignments/[id]. The legacy shifts table
  // doesn't carry that id directly, so we look up assignments for
  // the same (date range, location?, profile?) and stitch in by
  // composite key. One extra round-trip; small payload.
  if ((data || []).length > 0) {
    let assnQuery = db
      .from('shift_assignments')
      .select(`
        id,
        profile_id,
        partial_reason,
        shift_blocks!block_id (
          block_date,
          location_id,
          template_id
        )
      `)
    if (startDate) assnQuery = assnQuery.gte('shift_blocks.block_date', startDate)
    if (endDate) assnQuery = assnQuery.lte('shift_blocks.block_date', endDate)
    if (profileId) assnQuery = assnQuery.eq('profile_id', profileId)
    if (locationId) assnQuery = assnQuery.eq('shift_blocks.location_id', locationId)
    const { data: assignments } = await assnQuery
    const byKey = new Map()
    for (const a of assignments || []) {
      const b = a.shift_blocks
      if (!b) continue
      // Composite natural key — matches the trigger's unique
      // constraint on shifts (location_id, profile_id,
      // shift_template_id, shift_date).
      byKey.set(
        `${b.block_date}|${b.location_id}|${a.profile_id}|${b.template_id}`,
        { id: a.id, partial_reason: a.partial_reason }
      )
    }
    for (const s of data) {
      const k = `${s.shift_date}|${s.location_id}|${s.profile_id}|${s.shift_template_id}`
      const stitched = byKey.get(k)
      s.shift_assignment_id = stitched?.id || null
      s.partial_reason = stitched?.partial_reason || null
    }
  }

  return NextResponse.json({ success: true, data })
}
