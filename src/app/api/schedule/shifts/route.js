import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess , getUserLocationIds} from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, isoDate, timeOfDay , MANAGER_ROLES} from '@/lib/schemas'

const ShiftCreateSchema = z.object({
  location_id: uuidLike,
  profile_id: uuidLike,
  shift_template_id: uuidLike,
  shift_date: isoDate,
  start_time_override: timeOfDay.nullable().optional(),
  end_time_override: timeOfDay.nullable().optional(),
  role_label: z.string().max(50).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
})

// Either a single shift or { shifts: [...] } batch.
const ShiftPostSchema = z.union([
  ShiftCreateSchema,
  z.object({ shifts: z.array(ShiftCreateSchema).min(1).max(500) }),
])

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
  return NextResponse.json({ success: true, data })
}

// POST /api/schedule/shifts — Create a shift (or batch create)
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const validation = await validateBody(request, ShiftPostSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const db = createServerClient()

  // Support batch creation: body.shifts = [{...}, {...}] or single shift
  const shifts = body.shifts || [body]

  // Reject the whole batch if any shift targets a location the caller
  // can't write to.
  const userLocationIds = getUserLocationIds(user)
  const invalidShift = shifts.find(s => !s.location_id || !userLocationIds.includes(s.location_id))
  if (invalidShift) {
    return NextResponse.json(
      { success: false, error: 'Cannot create shift in a location you do not belong to' },
      { status: 403 }
    )
  }

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
