import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'

export const runtime = 'nodejs'

// Fields visible to non-admin staff. Compensation, employment type and
// permissions are intentionally excluded — staff can see who exists but
// not their HR data.
const STAFF_PUBLIC_FIELDS = 'id, full_name, email, role, avatar_url, active'

// GET /api/staff — List staff in the caller's locations.
//   - owner/manager: full profile + HR fields
//   - head_coach/staff: slim public roster (no salary, employment type, etc.)
export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const userLocationIds = (user.locations || []).map(l => l.id)
  if (userLocationIds.length === 0) {
    return NextResponse.json({ success: true, data: [] })
  }

  // Find profiles that share at least one location with the caller.
  const { data: links, error: linksError } = await db
    .from('profile_locations')
    .select('profile_id')
    .in('location_id', userLocationIds)
  if (linksError) {
    return NextResponse.json({ success: false, error: linksError.message }, { status: 400 })
  }
  const profileIds = [...new Set((links || []).map(l => l.profile_id))]
  if (profileIds.length === 0) {
    return NextResponse.json({ success: true, data: [] })
  }

  const isAdmin = ['owner', 'manager'].includes(user.role)
  const selectClause = isAdmin
    ? '*, profile_locations(*, locations(*))'
    : `${STAFF_PUBLIC_FIELDS}, profile_locations(location_id, locations(id, name, slug))`

  const { data, error } = await db
    .from('profiles')
    .select(selectClause)
    .in('id', profileIds)
    .order('full_name', { ascending: true })

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}

// POST /api/staff — Create a new staff member. Owner-only.
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (user.role !== 'owner') {
    return NextResponse.json({ success: false, error: 'Forbidden — owner only' }, { status: 403 })
  }

  const body = await request.json()
  const db = createServerClient()

  if (!body.email || !body.full_name || !body.password) {
    return NextResponse.json({
      success: false,
      error: 'email, full_name, and password are required'
    }, { status: 400 })
  }

  // If the caller is creating an owner, ensure they're an owner themselves
  // (already enforced above — owners are the only role allowed here).
  // Reject unknown roles.
  const role = body.role || 'staff'
  if (!['owner', 'manager', 'head_coach', 'staff'].includes(role)) {
    return NextResponse.json({ success: false, error: 'Invalid role' }, { status: 400 })
  }

  // Constrain new staff to the caller's own locations to prevent cross-tenant
  // creation by a future multi-org owner.
  const callerLocationIds = (user.locations || []).map(l => l.id)
  const requestedLocationIds = Array.isArray(body.location_ids) ? body.location_ids : []
  const invalidLocations = requestedLocationIds.filter(id => !callerLocationIds.includes(id))
  if (invalidLocations.length > 0) {
    return NextResponse.json({
      success: false,
      error: 'Cannot assign staff to a location you do not belong to',
    }, { status: 403 })
  }

  // Create auth user — the DB trigger will auto-create the profile
  const { data: authData, error: authError } = await db.auth.admin.createUser({
    email: body.email,
    password: body.password,
    email_confirm: true,
    user_metadata: {
      full_name: body.full_name,
      role,
    },
  })

  if (authError) {
    return NextResponse.json({ success: false, error: authError.message }, { status: 400 })
  }

  // Update profile with role and HR fields (trigger creates with defaults)
  const updates = { role }
  if (body.permissions) updates.permissions = body.permissions
  if (body.employment_type) updates.employment_type = body.employment_type
  if (body.annual_salary != null) updates.annual_salary = body.annual_salary
  if (body.hourly_rate != null) updates.hourly_rate = body.hourly_rate
  if (body.contracted_hours_per_week != null) updates.contracted_hours_per_week = body.contracted_hours_per_week
  if (body.annual_leave_entitlement != null) updates.annual_leave_entitlement = body.annual_leave_entitlement

  await db.from('profiles').update(updates).eq('id', authData.user.id)

  // Assign to locations if specified
  if (requestedLocationIds.length > 0) {
    // Clear auto-assigned location first
    await db.from('profile_locations').delete().eq('profile_id', authData.user.id)

    const locationLinks = requestedLocationIds.map((loc_id, i) => ({
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
