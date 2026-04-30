import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody, uuidLike } from '@/lib/validate'

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')

const TimeOffRequestSchema = z.object({
  type: z.enum(['holiday', 'sick', 'unpaid', 'other']),
  start_date: ISO_DATE,
  end_date: ISO_DATE,
  reason: z.string().max(2000).nullable().optional(),
  location_id: uuidLike.optional(),
})

// GET /api/schedule/time-off?location_id=xxx&start_date=xxx&end_date=xxx&status=xxx&profile_id=xxx
export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const startDate = searchParams.get('start_date')
  const endDate = searchParams.get('end_date')
  const status = searchParams.get('status')
  const profileId = searchParams.get('profile_id')
  const db = createServerClient()

  let query = db.from('time_off_requests')
    .select(`
      *,
      profiles!profile_id(id, full_name, avatar_url, role),
      reviewer:profiles!reviewed_by(id, full_name)
    `)
    .order('start_date', { ascending: true })

  if (locationId) {
    query = query.eq('location_id', locationId)
  } else {
    const userLocationIds = (user.locations || []).map(l => l.id)
    if (userLocationIds.length === 0) return NextResponse.json({ success: true, data: [] })
    query = query.in('location_id', userLocationIds)
  }
  if (status) query = query.eq('status', status)

  // Date range filter — show requests that overlap with the given range
  if (startDate) query = query.lte('start_date', endDate || startDate)
  if (endDate) query = query.gte('end_date', startDate || endDate)

  // Staff can only see their own unless they're a manager/owner/head_coach
  if (['staff'].includes(user.role)) {
    query = query.eq('profile_id', user.id)
  } else if (profileId) {
    query = query.eq('profile_id', profileId)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}

// POST /api/schedule/time-off — Create a time-off request
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, TimeOffRequestSchema)
  if (!validation.ok) return validation.response
  const { type, start_date, end_date, reason, location_id } = validation.data

  // If location_id is explicitly passed, it must be one the caller belongs to.
  // Otherwise fall through to user.activeLocation below.
  if (location_id) {
    const guard = assertLocationAccess(user, location_id)
    if (guard) return guard
  }

  const db = createServerClient()

  // Calculate total days (simple: count calendar days inclusive)
  const start = new Date(start_date + 'T00:00:00')
  const end = new Date(end_date + 'T00:00:00')
  const totalDays = Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1

  if (totalDays < 1) {
    return NextResponse.json({ success: false, error: 'End date must be on or after start date' }, { status: 400 })
  }

  // If it's a holiday, check remaining allowance
  if (type === 'holiday') {
    const year = new Date(start_date).getFullYear()
    const { data: allowance } = await db.from('staff_allowances')
      .select('*')
      .eq('profile_id', user.id)
      .eq('year', year)
      .single()

    if (allowance) {
      const remaining = allowance.total_days + allowance.carried_over - allowance.used_days
      // Check pending requests too
      const { data: pending } = await db.from('time_off_requests')
        .select('total_days')
        .eq('profile_id', user.id)
        .eq('type', 'holiday')
        .eq('status', 'pending')
        .gte('start_date', `${year}-01-01`)
        .lte('start_date', `${year}-12-31`)

      const pendingDays = (pending || []).reduce((sum, r) => sum + Number(r.total_days), 0)
      if (totalDays > remaining - pendingDays) {
        return NextResponse.json({
          success: false,
          error: `Insufficient holiday balance. You have ${remaining - pendingDays} days remaining (including pending requests).`
        }, { status: 400 })
      }
    }
  }

  const { data, error } = await db.from('time_off_requests').insert({
    profile_id: user.id,
    location_id: location_id || user.activeLocation?.id,
    type,
    start_date,
    end_date,
    total_days: totalDays,
    reason: reason || null,
    status: 'pending',
  }).select(`
    *,
    profiles!profile_id(id, full_name, avatar_url, role)
  `).single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data }, { status: 201 })
}
