import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'

// POST /api/schedule/shifts/copy-week
// Copy all shifts from one week to another
// Body: { location_id, source_start (Mon), target_start (Mon) }
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user || !['owner', 'manager', 'head_coach'].includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const body = await request.json()
  const { location_id, source_start, target_start } = body

  if (!location_id || !source_start || !target_start) {
    return NextResponse.json({
      success: false,
      error: 'location_id, source_start, and target_start are required'
    }, { status: 400 })
  }

  const db = createServerClient()

  // Calculate source week end (source_start + 6 days)
  const sourceStartDate = new Date(source_start + 'T00:00:00')
  const sourceEndDate = new Date(sourceStartDate)
  sourceEndDate.setDate(sourceEndDate.getDate() + 6)
  const sourceEnd = sourceEndDate.toISOString().split('T')[0]

  // Fetch source shifts
  const { data: sourceShifts, error: fetchError } = await db.from('shifts')
    .select('*')
    .eq('location_id', location_id)
    .gte('shift_date', source_start)
    .lte('shift_date', sourceEnd)

  if (fetchError) return NextResponse.json({ success: false, error: fetchError.message }, { status: 400 })

  if (!sourceShifts || sourceShifts.length === 0) {
    return NextResponse.json({ success: false, error: 'No shifts found in the source week' }, { status: 404 })
  }

  // Calculate day offset between source and target
  const targetStartDate = new Date(target_start + 'T00:00:00')
  const dayOffset = Math.round((targetStartDate - sourceStartDate) / (1000 * 60 * 60 * 24))

  // Create new shifts with adjusted dates
  const newShifts = sourceShifts.map(s => {
    const shiftDate = new Date(s.shift_date + 'T00:00:00')
    shiftDate.setDate(shiftDate.getDate() + dayOffset)

    return {
      location_id: s.location_id,
      profile_id: s.profile_id,
      shift_template_id: s.shift_template_id,
      shift_date: shiftDate.toISOString().split('T')[0],
      start_time_override: s.start_time_override,
      end_time_override: s.end_time_override,
      role_label: s.role_label,
      notes: s.notes,
      status: 'scheduled',
      published: false,
      created_by: user.id,
    }
  })

  // Upsert to avoid duplicates (if a shift already exists for that slot, update it)
  const { data, error } = await db.from('shifts')
    .upsert(newShifts, { onConflict: 'location_id,profile_id,shift_template_id,shift_date', ignoreDuplicates: false })
    .select('*, shift_templates(*), profiles!profile_id(id, full_name, email, avatar_url, role)')

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data, copied: newShifts.length }, { status: 201 })
}
