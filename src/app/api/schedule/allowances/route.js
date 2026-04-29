import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'

// GET /api/schedule/allowances?profile_id=xxx&year=2026
export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const profileId = searchParams.get('profile_id') || user.id
  const year = searchParams.get('year') || new Date().getFullYear()
  const db = createServerClient()

  // Staff can only view their own allowance
  if (profileId !== user.id && !['owner', 'manager', 'head_coach'].includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const { data, error } = await db.from('staff_allowances')
    .select('*, profiles!profile_id(id, full_name)')
    .eq('profile_id', profileId)
    .eq('year', year)
    .single()

  if (error && error.code !== 'PGRST116') {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  // If no allowance record exists, return defaults
  if (!data) {
    return NextResponse.json({
      success: true,
      data: {
        profile_id: profileId,
        year: Number(year),
        total_days: 20,
        used_days: 0,
        carried_over: 0,
        remaining: 20,
      }
    })
  }

  return NextResponse.json({
    success: true,
    data: {
      ...data,
      remaining: data.total_days + data.carried_over - data.used_days,
    }
  })
}

// PUT /api/schedule/allowances — Set/update a staff member's allowance (managers only)
export async function PUT(request) {
  const user = await getCurrentUser()
  if (!user || !['owner', 'manager'].includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const body = await request.json()
  const { profile_id, year, total_days, carried_over } = body
  const db = createServerClient()

  if (!profile_id || !year) {
    return NextResponse.json({ success: false, error: 'profile_id and year are required' }, { status: 400 })
  }

  const { data, error } = await db.from('staff_allowances')
    .upsert({
      profile_id,
      year,
      total_days: total_days ?? 20,
      carried_over: carried_over ?? 0,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'profile_id,year' })
    .select()
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}
