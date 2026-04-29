import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'

// GET /api/schedule/shifts?location_id=xxx&start_date=2026-04-27&end_date=2026-05-03&profile_id=xxx
export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  const startDate = searchParams.get('start_date')
  const endDate = searchParams.get('end_date')
  const profileId = searchParams.get('profile_id')
  const db = createServerClient()

  let query = db.from('shifts')
    .select('*, shift_templates(*), profiles!profile_id(id, full_name, email, avatar_url, role)')
    .order('shift_date')

  if (locationId) query = query.eq('location_id', locationId)
  if (startDate) query = query.gte('shift_date', startDate)
  if (endDate) query = query.lte('shift_date', endDate)
  if (profileId) query = query.eq('profile_id', profileId)

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}

// POST /api/schedule/shifts — Create a shift (or batch create)
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user || !['owner', 'manager', 'head_coach'].includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const body = await request.json()
  const db = createServerClient()

  // Support batch creation: body.shifts = [{...}, {...}] or single shift
  const shifts = body.shifts || [body]

  const records = shifts.map(s => ({
    location_id: s.location_id,
    profile_id: s.profile_id,
    shift_template_id: s.shift_template_id,
    shift_date: s.shift_date,
    start_time_override: s.start_time_override || null,
    end_time_override: s.end_time_override || null,
    role_label: s.role_label || null,
    notes: s.notes || null,
    status: 'scheduled',
    published: false,
    created_by: user.id,
  }))

  // Check for time-off conflicts (warn but allow)
  const profileIds = [...new Set(records.map(r => r.profile_id))]
  const shiftDates = [...new Set(records.map(r => r.shift_date))]
  const minDate = shiftDates.sort()[0]
  const maxDate = shiftDates.sort().reverse()[0]

  const { data: timeOffConflicts } = await db.from('time_off_requests')
    .select('profile_id, type, start_date, end_date, profiles!profile_id(full_name)')
    .in('profile_id', profileIds)
    .eq('status', 'approved')
    .lte('start_date', maxDate)
    .gte('end_date', minDate)

  const warnings = (timeOffConflicts || []).map(t =>
    `${t.profiles?.full_name} has approved ${t.type} from ${t.start_date} to ${t.end_date}`
  )

  const { data, error } = await db.from('shifts')
    .upsert(records, { onConflict: 'location_id,profile_id,shift_template_id,shift_date', ignoreDuplicates: false })
    .select('*, shift_templates(*), profiles!profile_id(id, full_name, email, avatar_url, role)')

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data, warnings: warnings.length > 0 ? warnings : undefined }, { status: 201 })
}
