import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

// GET /api/staff — List all staff profiles
export async function GET() {
  const db = createServerClient()
  const { data, error } = await db
    .from('profiles')
    .select('*, profile_locations(*, locations(*))')
    .order('created_at', { ascending: true })

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}

// POST /api/staff — Create a new staff member (creates auth user + profile)
export async function POST(request) {
  const body = await request.json()
  const db = createServerClient()

  if (!body.email || !body.full_name || !body.password) {
    return NextResponse.json({
      success: false,
      error: 'email, full_name, and password are required'
    }, { status: 400 })
  }

  // Create auth user — the DB trigger will auto-create the profile
  const { data: authData, error: authError } = await db.auth.admin.createUser({
    email: body.email,
    password: body.password,
    email_confirm: true,
    user_metadata: {
      full_name: body.full_name,
      role: body.role || 'staff',
    },
  })

  if (authError) {
    return NextResponse.json({ success: false, error: authError.message }, { status: 400 })
  }

  // Update profile with role and permissions (trigger creates with defaults)
  if (body.role || body.permissions) {
    const updates = {}
    if (body.role) updates.role = body.role
    if (body.permissions) updates.permissions = body.permissions
    if (body.employment_type) updates.employment_type = body.employment_type
    if (body.annual_salary != null) updates.annual_salary = body.annual_salary
    if (body.hourly_rate != null) updates.hourly_rate = body.hourly_rate
    if (body.contracted_hours_per_week != null) updates.contracted_hours_per_week = body.contracted_hours_per_week
    if (body.annual_leave_entitlement != null) updates.annual_leave_entitlement = body.annual_leave_entitlement

    await db.from('profiles')
      .update(updates)
      .eq('id', authData.user.id)
  }

  // Assign to locations if specified
  if (body.location_ids && body.location_ids.length > 0) {
    // Clear auto-assigned location first
    await db.from('profile_locations').delete().eq('profile_id', authData.user.id)

    const locationLinks = body.location_ids.map((loc_id, i) => ({
      profile_id: authData.user.id,
      location_id: loc_id,
      is_default: i === 0,
    }))
    await db.from('profile_locations').insert(locationLinks)
  }

  // Fetch the complete profile
  const { data: profile } = await db
    .from('profiles')
    .select('*, profile_locations(*, locations(*))')
    .eq('id', authData.user.id)
    .single()

  return NextResponse.json({ success: true, data: profile }, { status: 201 })
}
