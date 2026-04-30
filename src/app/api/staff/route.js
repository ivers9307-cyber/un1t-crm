import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody, uuidLike } from '@/lib/validate'

export const runtime = 'nodejs'

// Input schemas --------------------------------------------------------------

const ROLE = z.enum(['owner', 'manager', 'head_coach', 'staff'])
const EMPLOYMENT_TYPE = z.enum(['fte', 'contractor', 'casual'])

// Salary/rate fields are stored as DECIMAL — accept reasonable bounds to
// reject obviously-wrong inputs (negative, NaN, comically large).
const MONEY = z.number().finite().min(0).max(10_000_000)
const HOURS = z.number().finite().min(0).max(168)        // hours per week ceiling
// Annual leave entitlement: NUMERIC(5,1) in the DB, UI step is 0.5, so
// half-days are valid (e.g. 25.5).
const DAYS = z.number().finite().min(0).max(366)

const CreateStaffSchema = z.object({
  email: z.string().email(),
  full_name: z.string().min(1).max(200),
  password: z.string().min(8).max(200),
  role: ROLE.optional(),
  // permissions is a JSONB blob — keep validation lenient so legacy or
  // future shapes (nested groups, string flags) don't trip up edits.
  permissions: z.record(z.string(), z.unknown()).optional(),
  location_ids: z.array(uuidLike).optional(),
  employment_type: EMPLOYMENT_TYPE.optional(),
  annual_salary: MONEY.nullable().optional(),
  hourly_rate: MONEY.nullable().optional(),
  contracted_hours_per_week: HOURS.nullable().optional(),
  annual_leave_entitlement: DAYS.nullable().optional(),
})

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

  const validation = await validateBody(request, CreateStaffSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()
  const role = body.role || 'staff'

  // Constrain new staff to the caller's own locations to prevent cross-tenant
  // creation by a future multi-org owner.
  const callerLocationIds = (user.locations || []).map(l => l.id)
  const requestedLocationIds = body.location_ids || []
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
