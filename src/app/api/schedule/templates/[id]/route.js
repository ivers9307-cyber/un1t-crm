import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'

// PUT /api/schedule/templates/:id
export async function PUT(request, { params }) {
  const user = await getCurrentUser()
  if (!user || !['owner', 'manager', 'head_coach'].includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const body = await request.json()
  const db = createServerClient()

  const updates = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.start_time !== undefined) updates.start_time = body.start_time
  if (body.end_time !== undefined) updates.end_time = body.end_time
  if (body.color !== undefined) updates.color = body.color
  if (body.role_label !== undefined) updates.role_label = body.role_label
  if (body.active !== undefined) updates.active = body.active
  if (body.display_order !== undefined) updates.display_order = body.display_order

  const { data, error } = await db.from('shift_templates')
    .update(updates)
    .eq('id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}

// DELETE /api/schedule/templates/:id
export async function DELETE(request, { params }) {
  const user = await getCurrentUser()
  if (!user || !['owner', 'manager', 'head_coach'].includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const db = createServerClient()

  // Soft-delete by deactivating (can't delete if shifts reference it)
  const { data, error } = await db.from('shift_templates')
    .update({ active: false })
    .eq('id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}
