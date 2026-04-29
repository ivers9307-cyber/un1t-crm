import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'

// PUT /api/schedule/shifts/:id
export async function PUT(request, { params }) {
  const user = await getCurrentUser()
  if (!user || !['owner', 'manager', 'head_coach'].includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const body = await request.json()
  const db = createServerClient()

  const updates = {}
  if (body.shift_template_id !== undefined) updates.shift_template_id = body.shift_template_id
  if (body.shift_date !== undefined) updates.shift_date = body.shift_date
  if (body.start_time_override !== undefined) updates.start_time_override = body.start_time_override
  if (body.end_time_override !== undefined) updates.end_time_override = body.end_time_override
  if (body.role_label !== undefined) updates.role_label = body.role_label
  if (body.notes !== undefined) updates.notes = body.notes
  if (body.status !== undefined) updates.status = body.status
  if (body.published !== undefined) {
    updates.published = body.published
    if (body.published) updates.published_at = new Date().toISOString()
  }

  const { data, error } = await db.from('shifts')
    .update(updates)
    .eq('id', params.id)
    .select('*, shift_templates(*), profiles!profile_id(id, full_name, email, avatar_url, role)')
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}

// DELETE /api/schedule/shifts/:id
export async function DELETE(request, { params }) {
  const user = await getCurrentUser()
  if (!user || !['owner', 'manager', 'head_coach'].includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const db = createServerClient()
  const { error } = await db.from('shifts').delete().eq('id', params.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true })
}
