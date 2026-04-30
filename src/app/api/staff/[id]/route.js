import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody, uuidLike } from '@/lib/validate'

export const runtime = 'nodejs'

const ROLE = z.enum(['owner', 'manager', 'head_coach', 'staff'])
const EMPLOYMENT_TYPE = z.enum(['fte', 'contractor', 'casual'])
const MONEY = z.number().finite().min(0).max(10_000_000)
const HOURS = z.number().finite().min(0).max(168)
// Annual leave entitlement: NUMERIC(5,1) in the DB, UI step is 0.5, so
// half-days are valid (e.g. 25.5). Bound at 366 (one year).
const DAYS = z.number().finite().min(0).max(366)

const UpdateStaffSchema = z.object({
  full_name: z.string().min(1).max(200).optional(),
  role: ROLE.optional(),
  // permissions is a JSONB blob — keep validation lenient so legacy or
  // future shapes (nested groups, string flags) don't trip up edits.
  permissions: z.record(z.string(), z.unknown()).optional(),
  active: z.boolean().optional(),
  location_ids: z.array(uuidLike).optional(),
  employment_type: EMPLOYMENT_TYPE.optional(),
  annual_salary: MONEY.nullable().optional(),
  hourly_rate: MONEY.nullable().optional(),
  contracted_hours_per_week: HOURS.nullable().optional(),
  annual_leave_entitlement: DAYS.nullable().optional(),
})

// PUT /api/staff/[id] — Update a staff member. Owner-only.
// Includes role / salary / employment fields so this endpoint must never
// be reachable without owner authentication. Manager-level edits (e.g.
// shift availability) live elsewhere.
export async function PUT(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (user.role !== 'owner') {
    return NextResponse.json({ success: false, error: 'Forbidden — owner only' }, { status: 403 })
  }

  const { id } = params
  const validation = await validateBody(request, UpdateStaffSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const db = createServerClient()

  // Restrict location assignments to the caller's own locations
  if (body.location_ids !== undefined) {
    const callerLocationIds = (user.locations || []).map(l => l.id)
    const invalid = body.location_ids.filter(loc => !callerLocationIds.includes(loc))
    if (invalid.length > 0) {
      return NextResponse.json({
        success: false,
        error: 'Cannot assign staff to a location you do not belong to',
      }, { status: 403 })
    }
  }

  // Update profile fields
  const profileUpdates = {}
  if (body.full_name !== undefined) profileUpdates.full_name = body.full_name
  if (body.role !== undefined) profileUpdates.role = body.role
  if (body.permissions !== undefined) profileUpdates.permissions = body.permissions
  if (body.active !== undefined) profileUpdates.active = body.active
  if (body.employment_type !== undefined) profileUpdates.employment_type = body.employment_type
  if (body.annual_salary !== undefined) profileUpdates.annual_salary = body.annual_salary
  if (body.hourly_rate !== undefined) profileUpdates.hourly_rate = body.hourly_rate
  if (body.contracted_hours_per_week !== undefined) profileUpdates.contracted_hours_per_week = body.contracted_hours_per_week
  if (body.annual_leave_entitlement !== undefined) profileUpdates.annual_leave_entitlement = body.annual_leave_entitlement

  if (Object.keys(profileUpdates).length > 0) {
    const { error } = await db.from('profiles').update(profileUpdates).eq('id', id)
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  // Update location assignments
  if (body.location_ids !== undefined) {
    await db.from('profile_locations').delete().eq('profile_id', id)
    if (body.location_ids.length > 0) {
      const links = body.location_ids.map((loc_id, i) => ({
        profile_id: id,
        location_id: loc_id,
        is_default: i === 0,
      }))
      await db.from('profile_locations').insert(links)
    }
  }

  // Fetch updated profile
  const { data } = await db
    .from('profiles')
    .select('*, profile_locations(*, locations(*))')
    .eq('id', id)
    .single()

  return NextResponse.json({ success: true, data })
}

// DELETE /api/staff/[id] — Soft-delete (deactivate) a staff member. Owner-only.
export async function DELETE(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (user.role !== 'owner') {
    return NextResponse.json({ success: false, error: 'Forbidden — owner only' }, { status: 403 })
  }

  const { id } = params

  // Don't let an owner deactivate themselves — that would lock them out and
  // potentially leave the org with no active owner.
  if (id === user.id) {
    return NextResponse.json({
      success: false,
      error: 'Cannot deactivate your own account',
    }, { status: 400 })
  }

  const db = createServerClient()
  const { error } = await db.from('profiles').update({ active: false }).eq('id', id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return NextResponse.json({ success: true })
}
