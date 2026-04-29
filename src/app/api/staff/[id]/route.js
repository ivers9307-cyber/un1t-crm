import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

// PUT /api/staff/[id] — Update a staff member's profile, role, permissions, or locations
export async function PUT(request, { params }) {
  const { id } = params
  const body = await request.json()
  const db = createServerClient()

  // Update profile fields
  const profileUpdates = {}
  if (body.full_name !== undefined) profileUpdates.full_name = body.full_name
  if (body.role !== undefined) profileUpdates.role = body.role
  if (body.permissions !== undefined) profileUpdates.permissions = body.permissions
  if (body.active !== undefined) profileUpdates.active = body.active

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

// DELETE /api/staff/[id] — Deactivate a staff member
export async function DELETE(request, { params }) {
  const { id } = params
  const db = createServerClient()

  // Soft delete — deactivate rather than remove
  const { error } = await db.from('profiles').update({ active: false }).eq('id', id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return NextResponse.json({ success: true })
}
