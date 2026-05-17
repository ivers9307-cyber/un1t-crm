import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, isoDate, timeOfDay , MANAGER_ROLES} from '@/lib/schemas'

const ShiftUpdateSchema = z.object({
  shift_template_id: uuidLike.optional(),
  shift_date: isoDate.optional(),
  start_time_override: timeOfDay.nullable().optional(),
  end_time_override: timeOfDay.nullable().optional(),
  role_label: z.string().max(50).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  status: z.enum(['scheduled', 'completed', 'cancelled', 'no_show']).optional(),
  published: z.boolean().optional(),
})

// PUT /api/schedule/shifts/:id
export async function PUT(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const validation = await validateBody(request, ShiftUpdateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const db = createServerClient()

  const updates = { ...body }
  if (updates.published === true) {
    updates.published_at = new Date().toISOString()
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
export async function DELETE(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const db = createServerClient()
  const { error } = await db.from('shifts').delete().eq('id', params.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true })
}
